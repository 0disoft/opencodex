import { spawnSync } from "node:child_process";
import { currentServiceHomes } from "../service/state";
import { probeUpdateLauncherHome, updateHomeProbeEnvironment } from "./service-home-probe.mjs";

/** Refuse old launchers without executing their pre-dispatch bootstrap. */
export function automaticUpdateLauncherSupported(launcher: string, node: string): boolean {
  try {
    const env = updateHomeProbeEnvironment(process.env, currentServiceHomes());
    return probeUpdateLauncherHome(launcher, spawnSync, node, env).kind !== "unknown";
  } catch { return false; }
}
