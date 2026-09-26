import "../pilot.css";

import { startRendererPilotPage } from "../harness/page";

import { mountAngularRendererPilot } from "./mount";

void startRendererPilotPage("angular", mountAngularRendererPilot);
