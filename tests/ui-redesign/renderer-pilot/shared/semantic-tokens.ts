export const pilotSemanticTokens = {
  surface: "--color-bg-primary",
  secondarySurface: "--color-bg-secondary",
  heading: "--color-fg-heading",
  body: "--color-fg-body",
  error: "--color-fg-danger",
  primaryAction: "--color-bg-brand",
  primaryActionText: "--color-fg-contrast",
  border: "--color-border-base",
  focus: "--color-border-focus",
} as const;

export type PilotSemanticToken = (typeof pilotSemanticTokens)[keyof typeof pilotSemanticTokens];
