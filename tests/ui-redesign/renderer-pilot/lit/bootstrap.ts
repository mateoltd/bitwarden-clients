import "../pilot.css";

import { startRendererPilotPage } from "../harness/page";

import { mountLitRendererPilot } from "./mount";

void startRendererPilotPage("lit", mountLitRendererPilot);
