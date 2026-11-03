export interface MetricDefinition {
  label: string;
  // Every us-gaap tag that can carry this metric, in tie-break order. See docs/data-notes.md
  // for the tags left out on purpose and why.
  tags: readonly string[];
  canBeNegative: boolean;
}

export const METRICS = {
  capex: {
    label: 'Capital expenditures (purchases of property and equipment)',
    tags: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    canBeNegative: false,
  },
  revenue: {
    label: 'Revenue',
    tags: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
    ],
    canBeNegative: false,
  },
  rd_expense: {
    label: 'Research and development expense',
    tags: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
    canBeNegative: false,
  },
  operating_income: {
    label: 'Operating income (loss)',
    tags: ['OperatingIncomeLoss'],
    canBeNegative: true,
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricId = keyof typeof METRICS;

export const METRIC_IDS = Object.keys(METRICS) as [MetricId, ...MetricId[]];

export const CANDIDATE_TAGS: ReadonlySet<string> = new Set(Object.values(METRICS).flatMap((metric) => metric.tags));
