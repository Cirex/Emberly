/** Settings screen copy (manager subset of the maintenance settings). */
const en = {
  settings: {
    title: "Settings",
    subtitle: "Device preferences and account",
    appearance: "Appearance",
    theme: { system: "System", light: "Light", dark: "Dark" },
    themeLabel: "Theme",
    accent: "Accent",
    accentSub: "Tints buttons, tabs, and highlights",
    language: "Language",
    data: "Data",
    dataCounts: "{{units}} units",
    syncedJustNow: "Synced just now",
    syncedMinutes: "Synced {{count}}m ago",
    neverSynced: "Not synced yet this session",
    syncNow: "Sync now",
    account: "Account",
    signedInVia: "Signed in via ResMan",
    switchUser: "Switch user",
    signedInAs: "Signed in as",
    signOut: "Sign out",
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  settings: {
    title: "Ajustes",
    subtitle: "Preferencias del dispositivo y cuenta",
    appearance: "Apariencia",
    theme: { system: "Sistema", light: "Claro", dark: "Oscuro" },
    themeLabel: "Tema",
    accent: "Acento",
    accentSub: "Da color a botones, pestañas y resaltados",
    language: "Idioma",
    data: "Datos",
    dataCounts: "{{units}} unidades",
    syncedJustNow: "Sincronizado justo ahora",
    syncedMinutes: "Sincronizado hace {{count}}m",
    neverSynced: "Aún sin sincronizar en esta sesión",
    syncNow: "Sincronizar",
    account: "Cuenta",
    signedInVia: "Sesión iniciada vía ResMan",
    switchUser: "Cambiar de usuario",
    signedInAs: "Sesión iniciada como",
    signOut: "Cerrar sesión",
  },
};

export const settings = { en, es };
