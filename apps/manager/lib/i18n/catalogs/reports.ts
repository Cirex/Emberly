/** Owner-report card + PAST REPORTS band copy. OWNED by the reports feature agent. */
const en = {
  reports: {
    card: {
      /** "July report is ready" */
      title: "{{month}} report is ready",
      open: "Open",
      /**
       * The phone's document action. Sharing/previewing the PDF on-device
       * needs a file-system + share module the app doesn't ship yet, so the
       * single action opens the admin portal's archive instead (the mockup's
       * "Archive lives in the admin portal too").
       */
      openPortal: "Open in admin portal",
      headline: {
        occupancy: "Occupancy {{value}}",
        collected: "collected {{amount}}",
        delinquencyDown: "delinquency down {{amount}}",
        delinquencyUp: "delinquency up {{amount}}",
        turns_one: "{{count}} turn completed",
        turns_other: "{{count}} turns completed",
      },
    },
    past: {
      band: "Past reports",
      stats: {
        occupancy: "Occupancy {{value}}",
        collections: "collected {{value}}",
      },
      pdf: "PDF",
    },
    footer: "Archive lives in the admin portal too",
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  reports: {
    card: {
      title: "El informe de {{month}} está listo",
      open: "Abrir",
      openPortal: "Abrir en el portal de administración",
      headline: {
        occupancy: "Ocupación {{value}}",
        collected: "cobrado {{amount}}",
        delinquencyDown: "morosidad baja {{amount}}",
        delinquencyUp: "morosidad sube {{amount}}",
        turns_one: "{{count}} rotación completada",
        turns_other: "{{count}} rotaciones completadas",
      },
    },
    past: {
      band: "Informes anteriores",
      stats: {
        occupancy: "Ocupación {{value}}",
        collections: "cobrado {{value}}",
      },
      pdf: "PDF",
    },
    footer: "El archivo también vive en el portal de administración",
  },
};

export const reports = { en, es };
