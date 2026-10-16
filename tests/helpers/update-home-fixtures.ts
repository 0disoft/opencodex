import type { RestartIo } from "../../src/update/job";

/** Non-home restart tests explicitly own their fake service and never touch a live manager. */
export const sameHomeRestartIo: Pick<RestartIo, "serviceHomeAuthorityFn" | "stopServiceWrappersFn"> = {
  serviceHomeAuthorityFn: () => ({ kind: "same" }),
  stopServiceWrappersFn: () => {},
};
export const absentHomeRestartIo: typeof sameHomeRestartIo = {
  ...sameHomeRestartIo,
  serviceHomeAuthorityFn: () => ({ kind: "absent" }),
};
