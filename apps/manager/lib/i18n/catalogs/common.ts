/**
 * Shared strings: tab titles, sign-in, and generic UI. Feature-specific copy
 * belongs in that feature's own catalog file, not here.
 */
const en = {
  tabs: {
    today: "Today",
    leasing: "Leasing",
    money: "Money",
    utilities: "Utilities",
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
  placeholder: {
    title: "Coming in this build",
    body: "This workspace is being assembled. Check back after the next update.",
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  tabs: {
    today: "Hoy",
    leasing: "Arrendamiento",
    money: "Dinero",
    utilities: "Servicios",
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
  placeholder: {
    title: "Disponible en una próxima versión",
    body: "Este espacio de trabajo está en construcción. Vuelve después de la próxima actualización.",
  },
};

export const common = { en, es };
