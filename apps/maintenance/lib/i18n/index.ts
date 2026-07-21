import i18n from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * App i18n (AGENTS.md · Localization): i18next with English as the source
 * language and Spanish required for user-facing text. Keys are scoped and
 * stable ("settings.appearance", "myDay.greeting.morning"); counts use
 * i18next plurals (_one/_other); brand names (Emberly, ResMan), IDs, unit
 * numbers, and machine values are never translated.
 *
 * The selected language lives in the settings store (Zustand, persisted) —
 * `setLanguage` there calls `changeAppLanguage`. Default is English; there is
 * no native locale-detection dependency by design (JS-only, no pod churn).
 */

export type AppLanguage = "en" | "es";

const en = {
  tabs: {
    myDay: "My Day",
    workOrders: "Work Orders",
    makeReady: "Make Ready",
    map: "Map",
  },
  signIn: {
    username: "Username",
    password: "Password",
    showPassword: "Show password",
    hidePassword: "Hide password",
    signIn: "Sign In",
    signingIn: "Signing In…",
    errors: {
      invalid: "That username or password wasn’t accepted. Check them and try again.",
      rate_limited: "Too many attempts. Wait a few minutes and try again.",
      unavailable: "ResMan sign-in is temporarily unavailable. Try again shortly.",
      unreachable: "Can’t reach the server. Check the network connection and try again.",
    },
  },
  settings: {
    title: "Settings",
    appearance: "Appearance",
    theme: { system: "System", light: "Light", dark: "Dark" },
    fieldMode: "Field Mode",
    language: "Language",
    signedInAs: "Signed in as",
    signOut: "Sign Out",
  },
  workOrders: {
    modes: { open: "Open", closed: "Closed", hotSpots: "Hot Spots" },
    modeMenuA11y: "Viewing {{mode}}; change mode",
  },
  scoreCards: {
    openTotal: "Open Work Orders",
    submittedMonth: "Submitted in Month",
    agingRisk: "Aging Risk",
    callbacks: "Callbacks",
    closedSameWeek: "Closed Same Week",
    avgDaysToClose: "Avg Days to Close",
    closedThisWeek: "Closed This Week",
    closedThisMonth: "Closed This Month",
    turnsInProgress: "Turns in Progress",
    completedThisMonth: "Completed This Month",
    avgDaysInTurn: "Avg Days in Turn",
    overdueTurns: "Overdue Turns",
    hotSpotUnits: "Hot Spot Units",
    highRiskUnits: "High Risk Units",
    openOnHotSpots: "Open on Hot Spots",
    callbackSignals: "Callback Signals",
    captions: {
      unitsWithOpenWork: "{{count}} units with open work",
      pctCompleted: "{{pct}}% completed",
      noDatedOpen: "No dated open work orders",
      agingDetail: "Oldest {{oldest}}, avg {{avg}} open",
      noCallbacks: "No callback candidates in view",
      callbackMatches_one: "{{count}} open ticket matches completed work",
      callbackMatches_other: "{{count}} open tickets match completed work",
      noClosed90: "No closed work orders in the last 90 days",
      sameWeekDetail: "{{pct}}% of {{sample}} tickets in 90 days",
      noClosedInView: "No closed work orders in view",
      acrossClosed: "Across {{count}} closed work orders",
      noTechWeek: "No technician completions this week",
      noTechMonth: "No technician completions this month",
      avgPerTech: "Avg {{value}} per technician",
      day_one: "{{count}} day",
      day_other: "{{count}} days",
      daysDecimal: "{{value}} days",
      unitsNotReady: "Units not yet ready",
      turnsStarted_one: "{{count}} turn started this month",
      turnsStarted_other: "{{count}} turns started this month",
      noTurns90: "No completed turns in the last 3 months",
      acrossTurns90: "Across {{count}} turns in 90 days",
      noOverdueTurns: "No turns past move-in date",
      overdueTurns_one: "{{count}} turn past move-in date",
      overdueTurns_other: "{{count}} turns past move-in date",
      repeatSignals: "Units with repeat maintenance signals",
      noHighRisk: "No high-risk hot spots",
      needsReview_one: "{{count}} unit needs review",
      needsReview_other: "{{count}} units need review",
      noOpenHotSpots: "No open work on hot spots",
      openOnHotSpots: "Open tickets tied to hot spot units",
      recentTickets90: "{{count}} recent tickets in 90 days",
    },
  },
  myDay: {
    greeting: { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening" },
    assigned_one: "{{count}} work order assigned",
    assigned_other: "{{count}} work orders assigned",
    metrics: { assigned: "Assigned", urgent: "Urgent", completedToday: "Completed Today" },
    pathPill_one: "TODAY’S PATH · {{count}} STOP",
    pathPill_other: "TODAY’S PATH · {{count}} STOPS",
    rebuild: "Rebuild",
    map: "Map",
    openPathInMap: "Open path in map",
    upNext: "UP NEXT",
    tickets: "{{count}} tickets",
    workOrder: "Work order",
    untitledWorkOrder: "Untitled work order",
    emergency: "EMERGENCY",
    unassignedPinned: "Unassigned · pinned for everyone",
    doneToday: "Done today · {{count}}",
    syncingToResman: "syncing to ResMan",
    closedLine: "✓ Work order closed",
    markDone: "Mark done",
    markNotDone: "Mark not done",
    close: "Close",
    add: "Add",
    emptySignedIn: "No open work orders are assigned to you right now.",
    emptySignedOut: "Sign in to build your path.",
    queueHeader: "ASSIGNED · NOT ON PATH · {{count}}",
    queueEmpty: "Everything assigned to you is already on the path.",
    toastClosed_one: "Closed work order · {{unit}}",
    toastClosed_other: "Closed {{count}} work orders · {{unit}}",
    toastAdded: "Added to your path as stop {{position}}",
    undo: "Undo",
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  tabs: {
    myDay: "Mi día",
    workOrders: "Órdenes de trabajo",
    makeReady: "Preparación",
    map: "Mapa",
  },
  signIn: {
    username: "Usuario",
    password: "Contraseña",
    showPassword: "Mostrar contraseña",
    hidePassword: "Ocultar contraseña",
    signIn: "Iniciar sesión",
    signingIn: "Iniciando sesión…",
    errors: {
      invalid: "Ese usuario o contraseña no fue aceptado. Revísalos e intenta de nuevo.",
      rate_limited: "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
      unavailable: "El inicio de sesión de ResMan no está disponible por ahora. Intenta en un momento.",
      unreachable: "No se puede conectar al servidor. Revisa la red e intenta de nuevo.",
    },
  },
  settings: {
    title: "Ajustes",
    appearance: "Apariencia",
    theme: { system: "Sistema", light: "Claro", dark: "Oscuro" },
    fieldMode: "Modo exterior",
    language: "Idioma",
    signedInAs: "Sesión iniciada como",
    signOut: "Cerrar sesión",
  },
  workOrders: {
    modes: { open: "Abiertas", closed: "Cerradas", hotSpots: "Puntos críticos" },
    modeMenuA11y: "Viendo {{mode}}; cambiar modo",
  },
  scoreCards: {
    openTotal: "Órdenes abiertas",
    submittedMonth: "Recibidas en el mes",
    agingRisk: "Riesgo de atraso",
    callbacks: "Reincidencias",
    closedSameWeek: "Cerradas la misma semana",
    avgDaysToClose: "Días promedio de cierre",
    closedThisWeek: "Cerradas esta semana",
    closedThisMonth: "Cerradas este mes",
    turnsInProgress: "Preparaciones en curso",
    completedThisMonth: "Completadas este mes",
    avgDaysInTurn: "Días promedio por preparación",
    overdueTurns: "Preparaciones atrasadas",
    hotSpotUnits: "Unidades críticas",
    highRiskUnits: "Unidades de alto riesgo",
    openOnHotSpots: "Abiertas en puntos críticos",
    callbackSignals: "Señales de reincidencia",
    captions: {
      unitsWithOpenWork: "{{count}} unidades con trabajo abierto",
      pctCompleted: "{{pct}}% completadas",
      noDatedOpen: "Sin órdenes abiertas con fecha",
      agingDetail: "La más antigua {{oldest}}, promedio {{avg}} abiertas",
      noCallbacks: "Sin candidatas a reincidencia a la vista",
      callbackMatches_one: "{{count}} ticket abierto coincide con trabajo completado",
      callbackMatches_other: "{{count}} tickets abiertos coinciden con trabajo completado",
      noClosed90: "Sin órdenes cerradas en los últimos 90 días",
      sameWeekDetail: "{{pct}}% de {{sample}} tickets en 90 días",
      noClosedInView: "Sin órdenes cerradas a la vista",
      acrossClosed: "Entre {{count}} órdenes cerradas",
      noTechWeek: "Sin cierres por técnico esta semana",
      noTechMonth: "Sin cierres por técnico este mes",
      avgPerTech: "Promedio {{value}} por técnico",
      day_one: "{{count}} día",
      day_other: "{{count}} días",
      daysDecimal: "{{value}} días",
      unitsNotReady: "Unidades aún no listas",
      turnsStarted_one: "{{count}} preparación iniciada este mes",
      turnsStarted_other: "{{count}} preparaciones iniciadas este mes",
      noTurns90: "Sin preparaciones completadas en los últimos 3 meses",
      acrossTurns90: "Entre {{count}} preparaciones en 90 días",
      noOverdueTurns: "Sin preparaciones pasadas de la fecha de mudanza",
      overdueTurns_one: "{{count}} preparación pasada de la fecha de mudanza",
      overdueTurns_other: "{{count}} preparaciones pasadas de la fecha de mudanza",
      repeatSignals: "Unidades con señales de mantenimiento repetido",
      noHighRisk: "Sin puntos críticos de alto riesgo",
      needsReview_one: "{{count}} unidad requiere revisión",
      needsReview_other: "{{count}} unidades requieren revisión",
      noOpenHotSpots: "Sin trabajo abierto en puntos críticos",
      openOnHotSpots: "Tickets abiertos ligados a unidades críticas",
      recentTickets90: "{{count}} tickets recientes en 90 días",
    },
  },
  myDay: {
    greeting: { morning: "Buenos días", afternoon: "Buenas tardes", evening: "Buenas noches" },
    assigned_one: "{{count}} orden de trabajo asignada",
    assigned_other: "{{count}} órdenes de trabajo asignadas",
    metrics: { assigned: "Asignadas", urgent: "Urgentes", completedToday: "Completadas hoy" },
    pathPill_one: "RUTA DE HOY · {{count}} PARADA",
    pathPill_other: "RUTA DE HOY · {{count}} PARADAS",
    rebuild: "Rehacer",
    map: "Mapa",
    openPathInMap: "Abrir la ruta en el mapa",
    upNext: "SIGUIENTE",
    tickets: "{{count}} tickets",
    workOrder: "Orden de trabajo",
    untitledWorkOrder: "Orden de trabajo sin título",
    emergency: "EMERGENCIA",
    unassignedPinned: "Sin asignar · fijada para todos",
    doneToday: "Hechas hoy · {{count}}",
    syncingToResman: "sincronizando con ResMan",
    closedLine: "✓ Orden de trabajo cerrada",
    markDone: "Marcar como hecha",
    markNotDone: "Marcar como no hecha",
    close: "Cerrar",
    add: "Agregar",
    emptySignedIn: "No tienes órdenes de trabajo abiertas asignadas ahora.",
    emptySignedOut: "Inicia sesión para armar tu ruta.",
    queueHeader: "ASIGNADAS · FUERA DE RUTA · {{count}}",
    queueEmpty: "Todo lo asignado ya está en tu ruta.",
    toastClosed_one: "Se cerró la orden de trabajo · {{unit}}",
    toastClosed_other: "Se cerraron {{count}} órdenes de trabajo · {{unit}}",
    toastAdded: "Agregada a tu ruta como parada {{position}}",
    undo: "Deshacer",
  },
};

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
});

/** Switch the app language. Called by the settings store; components re-render
 *  via useTranslation, and derived snapshots key on the language. */
export function changeAppLanguage(language: AppLanguage): void {
  if (i18n.language !== language) void i18n.changeLanguage(language);
}

/** The active locale tag for date formatting (toLocaleDateString etc.). */
export function activeLocale(): string {
  return i18n.language === "es" ? "es" : "en";
}

export default i18n;
