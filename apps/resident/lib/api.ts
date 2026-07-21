import axios, { AxiosError } from 'axios';
import Constants from 'expo-constants';
import { PRODUCTION_ORIGIN } from '@emberly/core';
import { normalizeGuestPassesResponse, type ApiGuestPass, type GuestPass } from './guestPasses';
import { classifyHeartbeatFailure, type HeartbeatResult } from './sessionHeartbeat';

const PRODUCTION_API_BASE_URL = `${PRODUCTION_ORIGIN}/api`;
const DEFAULT_DEVELOPMENT_API_PORT = '3001';

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function hostFromExpoHostUri(hostUri?: string | null): string | null {
  if (!hostUri) {
    return null;
  }

  const withoutProtocol = hostUri.replace(/^[a-z]+:\/\//i, '');
  const hostWithPort = withoutProtocol.split('/')[0];
  const host = hostWithPort.split(':')[0];

  return host || null;
}

function getDevelopmentApiBaseUrl(): string | null {
  const host = hostFromExpoHostUri(Constants.expoConfig?.hostUri);
  if (!host) return null;

  const port = process.env.EXPO_PUBLIC_API_PORT ?? DEFAULT_DEVELOPMENT_API_PORT;
  return `http://${host}:${port}/api`;
}

function resolveApiBaseUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (configuredUrl) {
    if (!__DEV__ && !/^https:\/\//i.test(configuredUrl.trim())) {
      throw new Error(
        'EXPO_PUBLIC_API_BASE_URL must use https in production builds. Refusing to send credentials over cleartext.'
      );
    }
    return normalizeBaseUrl(configuredUrl);
  }

  if (__DEV__) {
    const developmentUrl = getDevelopmentApiBaseUrl();
    if (developmentUrl) {
      return normalizeBaseUrl(developmentUrl);
    }

    throw new Error(
      'Missing development API URL. Set EXPO_PUBLIC_API_BASE_URL in emberly-resident/.env.local.'
    );
  }

  return PRODUCTION_API_BASE_URL;
}

const API_BASE_URL = resolveApiBaseUrl();

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 45_000,
});

export class ApiRequestError extends Error {
  status?: number;
  reason?: string;
  existingPassId?: string;

  constructor(message: string, options: { status?: number; reason?: string; existingPassId?: string } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.reason = options.reason;
    this.existingPassId = options.existingPassId;
  }
}

function formatApiError(error: unknown): Error {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error : new Error('An unexpected network error occurred.');
  }

  const axiosError = error as AxiosError<{ error?: string; message?: string; reason?: string; existingPassId?: string } | string>;
  const status = axiosError.response?.status;
  const data = axiosError.response?.data;
  const serverMessage = typeof data === 'string' ? data : data?.error ?? data?.message;
  const reason = typeof data === 'string' ? undefined : data?.reason;
  const existingPassId = typeof data === 'string' ? undefined : data?.existingPassId;

  if (status === 404) {
    return new ApiRequestError(`API route was not found at ${API_BASE_URL}.`, { status, reason, existingPassId });
  }

  if (serverMessage) {
    return new ApiRequestError(serverMessage, { status, reason, existingPassId });
  }

  if (status) {
    return new ApiRequestError(`API request failed with status ${status}.`, { status, reason, existingPassId });
  }

  return new ApiRequestError('Unable to reach Emberly Web. Check that the API server is running and reachable from this device.');
}

async function requestData<T>(request: Promise<{ data: T }>): Promise<T> {
  try {
    const response = await request;
    return response.data;
  } catch (error) {
    throw formatApiError(error);
  }
}

export interface GuestPassRequest {
  name: string;
  email: string;
  phone: string;
  address?: string;
}

export interface ResmanSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface ResmanSession {
  baseUrl: string;
  signInUrl: string;
  cookieHeader: string;
  cookies: ResmanSessionCookie[];
  issuedAt: string;
  signature: string;
}

export interface ResmanAccess {
  allowed: boolean;
  unitNumber?: string;
  status?: string;
}

export interface EmberlyResidentIdentity {
  residentId: string;
  tenantId: string;
  ledgerId: string;
  name: string;
  unitId: string;
  unitNumber: string;
}

export interface ResidentDeviceSession {
  deviceId: string;
  token: string;
  expiresAt: string;
}

export interface EmberlySession {
  token: string;
  expiresAt: string;
  resident: EmberlyResidentIdentity;
  deviceSession?: ResidentDeviceSession;
}

// Returned when only one resident is linked to the login
export interface LoginSingleResponse {
  requiresSelection: false;
  resmanSession: ResmanSession;
  resmanAccess: ResmanAccess;
  emberlySession: EmberlySession;
}

// Returned when multiple residents share the same Resman login (shared household)
export interface LoginMultiResponse {
  requiresSelection: true;
  resmanSession: ResmanSession;
  resmanAccess: ResmanAccess;
  selectionToken: string;
  residents: ResidentOption[];
}

export interface ResidentOption {
  tenantId: string;
  ledgerId: string;
  residentId: string;
  name: string;
  unitId: string;
  unitNumber: string;
}

export type LoginResponse = LoginSingleResponse | LoginMultiResponse;

export interface SelectResidentResponse {
  emberlySession: EmberlySession;
}

export interface CreateGuestPassResponse {
  passId: string;
  qrData: string;
  shareUrl?: string;
  expiresAt?: string;
  pass: ApiGuestPass;
  warning?: string;
}

export interface ResendGuestPassEmailResponse {
  resent: boolean;
  passId: string;
  shareUrl?: string;
  expiresAt?: string;
}

export interface RevokeGuestPassResponse {
  revoked: boolean;
  passId: string;
  pass?: ApiGuestPass;
}

export interface ResidentEntryTokenResponse {
  entryToken: string;
  qrData: string;
  expiresAt: string;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function residentDeviceHeaders(token: string, deviceSession: ResidentDeviceSession) {
  return {
    ...authHeaders(token),
    'x-resident-device-token': deviceSession.token,
  };
}

export async function loginResident(
  username: string,
  password: string
): Promise<LoginResponse> {
  return requestData(api.post<LoginResponse>('/auth/resman-session', { username, password }));
}

/**
 * Called after the resident picker when multiple people share a Resman login.
 * Exchanges the resident-selection token + chosen residentId for a real app token.
 */
export async function selectResident(
  selectionToken: string,
  residentId: string
): Promise<SelectResidentResponse> {
  return requestData(
    api.post<SelectResidentResponse>('/auth/select-resident', { selectionToken, residentId })
  );
}

/**
 * Background session check. Sends the mobile-held ResMan session to the API so
 * the API can verify it in memory against ResMan without storing it.
 */
export async function verifySession(token: string, resmanSession: ResmanSession): Promise<HeartbeatResult> {
  try {
    const response = await api.post<{ valid: boolean; nextCheckAfter?: string; reason?: string }>(
      '/auth/resman-heartbeat',
      { resmanSession },
      { headers: authHeaders(token) }
    );
    return {
      status: response.data.valid ? 'valid' : 'invalid',
      nextCheckAfter: response.data.nextCheckAfter ?? null,
      reason: response.data.reason,
    };
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return { status: classifyHeartbeatFailure(status) };
  }
}

export async function createGuestPass(
  token: string,
  guest: GuestPassRequest
): Promise<CreateGuestPassResponse> {
  return requestData(
    api.post<CreateGuestPassResponse>('/resident/guest-pass', guest, {
      headers: authHeaders(token),
    })
  );
}

export async function resendGuestPassEmail(
  token: string,
  passId: string
): Promise<ResendGuestPassEmailResponse> {
  return requestData(
    api.post<ResendGuestPassEmailResponse>(
      `/resident/guest-passes/${passId}/resend`,
      {},
      { headers: authHeaders(token) }
    )
  );
}

export async function revokeGuestPass(
  token: string,
  passId: string
): Promise<RevokeGuestPassResponse> {
  return requestData(
    api.post<RevokeGuestPassResponse>(
      `/resident/guest-passes/${passId}/revoke`,
      {},
      { headers: authHeaders(token) }
    )
  );
}

export async function getResidentEntryToken(
  token: string,
  deviceSession: ResidentDeviceSession
): Promise<ResidentEntryTokenResponse> {
  return requestData(
    api.post<ResidentEntryTokenResponse>(
      '/resident/entry-token',
      {},
      { headers: residentDeviceHeaders(token, deviceSession) }
    )
  );
}

export async function getGuestPasses(token: string): Promise<GuestPass[]> {
  const response = await requestData(
    api.get<unknown>('/resident/guest-passes', { headers: authHeaders(token) })
  );
  return normalizeGuestPassesResponse(response as Parameters<typeof normalizeGuestPassesResponse>[0]);
}

export type { GuestPass };
