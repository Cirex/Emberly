import { AdminLoginSection, adminLoginErrorMessage } from "../_components/admin-login-section";

type AdminLoginPageProps = {
  searchParams?: Promise<{
    error?: string | string[];
  }>;
};

export default async function AdminLoginPage({ searchParams }: AdminLoginPageProps) {
  const params = await searchParams;
  const errorCode = Array.isArray(params?.error) ? params.error[0] : params?.error;
  return <AdminLoginSection error={adminLoginErrorMessage(errorCode)} returnTo="/admin/login" />;
}
