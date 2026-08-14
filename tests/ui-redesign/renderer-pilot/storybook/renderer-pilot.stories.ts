import { type Meta, type StoryObj, moduleMetadata } from "@storybook/angular";

import {
  AngularRendererPilotStoryHostComponent,
  LitRendererPilotStoryHostComponent,
  ReactRendererPilotStoryHostComponent,
} from "./story-hosts";

const meta = {
  title: "UI Redesign/Renderer Pilot",
  decorators: [
    moduleMetadata({
      imports: [
        AngularRendererPilotStoryHostComponent,
        LitRendererPilotStoryHostComponent,
        ReactRendererPilotStoryHostComponent,
      ],
    }),
  ],
  parameters: {
    chromatic: { disableSnapshot: true },
    docs: { disable: true },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Angular: Story = {
  render: () => ({
    template: `<ui-redesign-angular-renderer-pilot-story />`,
  }),
};

export const React: Story = {
  render: () => ({
    template: `<ui-redesign-react-renderer-pilot-story />`,
  }),
};

export const Lit: Story = {
  render: () => ({
    template: `<ui-redesign-lit-renderer-pilot-story />`,
  }),
};
