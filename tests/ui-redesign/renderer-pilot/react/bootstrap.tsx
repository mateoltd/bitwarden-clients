import "../pilot.css";

import { startRendererPilotPage } from "../harness/page";

import { mountReactRendererPilot } from "./mount";

void startRendererPilotPage("react", mountReactRendererPilot);
