import io, { Socket } from "socket.io-client";

type BridgeStatuses = "connected" | "not-ready";

export class Bridge {
  bridgeStatus: BridgeStatuses = "not-ready";
  bridgeSocket: Socket | null = null;

  constructor(public host: string) {}

  connectBridge(callback: () => void, dappAlias: any) {
    const socket = io(this.host, {
      transports: ["websocket"],
    });

    socket.on("connect", () => {
      this.bridgeStatus = "connected";
      socket.emit("upgrade-dapp", dappAlias);
      socket.emit("find-available-server", true);
    });

    socket.on("find-available-server", callback.bind(this));

    this.bridgeSocket = socket;
  }

  transportMessage(data: any) {
    this.bridgeSocket?.emit("transport", data);
  }
}
