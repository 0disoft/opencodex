import { expect, spyOn, test } from "bun:test";
import { remotePortCandidate } from "../../src/messaging/remote-ports";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { spawnRemoteHelper } from "../../src/messaging/remote-process";

test("remote candidate allocation requests an exclusive listener", () => {
  const listen = spyOn(Bun, "listen");
  try {
    remotePortCandidate();
    expect(listen.mock.calls[0]![0]).toMatchObject({ hostname: "127.0.0.1", port: 0, exclusive: true });
  } finally { listen.mockRestore(); }
});

for (const [direction, diagnostic, detected] of [
  ["L", "channel_setup_fwd_listener_tcpip: cannot listen to port: 23456\r\nCould not request local forwarding.\r\n", true],
  ["R", "Error: remote port forwarding failed for listen port 23456\r\n", true],
  ["R", "Error: remote port forwarding failed for listen port 23456\n", true],
  ["R", "Error: remote port forwarding failed for listen port 234560\n", false],
  ["R", "Permission denied (publickey).\n", false],
] as const) {
  test(`SSH ${direction} diagnostic ${JSON.stringify(diagnostic)} is classified without returning stderr`, async () => {
    const capacity = new RemoteCapacity();
    const helper = spawnRemoteHelper(["ssh", "-o", "ExitOnForwardFailure=yes", `-${direction}`,
      "127.0.0.1:23456:127.0.0.1:34567"], capacity, undefined, undefined, {}, {
      spawn: () => ({ pid: 12345, exitCode: 255, exited: Promise.resolve(255),
        stdout: new ReadableStream({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream({ start(controller) {
          for (const byte of new TextEncoder().encode(`private diagnostic\n${diagnostic}`)) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        } }), stdin: { write: () => 0, end: () => 0 } }),
      signalGroup() { throw new Error("an exited helper must not be signalled"); },
    });
    try {
      expect(await helper.output).toBe("");
      expect((helper as typeof helper & { forwardFailed?: boolean }).forwardFailed === true).toBe(detected);
    } finally { await helper.close(); }
    expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  });
}
