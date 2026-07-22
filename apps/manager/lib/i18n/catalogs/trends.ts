/** Trends sheet copy. OWNED by the Trends/snapshots feature agent. */
const en = {
  trends: {
    title: "Trends",
    close: "Close",
    ranges: {
      twelveMonths: "12 months",
      threeMonths: "3 months",
      thirtyDays: "30 days",
    },
    occupancy: {
      title: "Occupancy",
      /** "Aug → Jul · backfilled from lease spans before snapshots began" */
      legend: "{{from}} → {{to}} · backfilled from lease spans before snapshots began",
      legendNoRange: "Backfilled from lease spans before snapshots began",
      yoyDelta: "{{points}} pt YoY",
    },
    delinquency: {
      title: "Delinquency by age",
      buckets: {
        b0030: "0–30",
        b3190: "31–90",
        b90: "90+",
      },
      seriesBegan: "series began {{date}} — no backfill possible",
    },
    rentRoll: {
      title: "Rent roll",
      yoyDelta: "{{percent}}% YoY",
    },
    compare: {
      title: "This month vs last",
      caption: "from daily snapshots",
      collectionsRate: "Collections rate",
      delinquentUnits: "Delinquent units",
    },
    empty: {
      chart: "Not enough history yet",
      sheet: "Snapshots haven’t synced yet. The series starts accruing the day the nightly job ships.",
    },
    footer: "One snapshot row per day · charts read the table directly",
  },
};

/** Spanish catalog — mirrors `en` key-for-key. */
const es: typeof en = {
  trends: {
    title: "Tendencias",
    close: "Cerrar",
    ranges: {
      twelveMonths: "12 meses",
      threeMonths: "3 meses",
      thirtyDays: "30 días",
    },
    occupancy: {
      title: "Ocupación",
      legend: "{{from}} → {{to}} · reconstruida desde los contratos antes de que empezaran los cortes",
      legendNoRange: "Reconstruida desde los contratos antes de que empezaran los cortes",
      yoyDelta: "{{points}} pt interanual",
    },
    delinquency: {
      title: "Morosidad por antigüedad",
      buckets: {
        b0030: "0–30",
        b3190: "31–90",
        b90: "90+",
      },
      seriesBegan: "la serie empezó el {{date}} — sin reconstrucción posible",
    },
    rentRoll: {
      title: "Renta total",
      yoyDelta: "{{percent}}% interanual",
    },
    compare: {
      title: "Este mes vs el anterior",
      caption: "de los cortes diarios",
      collectionsRate: "Tasa de cobranza",
      delinquentUnits: "Unidades morosas",
    },
    empty: {
      chart: "Aún no hay suficiente historial",
      sheet: "Los cortes aún no se han sincronizado. La serie empieza a acumularse el día que se activa el proceso nocturno.",
    },
    footer: "Un corte por día · las gráficas leen la tabla directamente",
  },
};

export const trends = { en, es };
