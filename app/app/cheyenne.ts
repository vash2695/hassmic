import TcpSocket from 'react-native-tcp-socket';
import {APP_VERSION} from './constants';
import {Buffer} from 'buffer';
import {NativeManager} from './nativemgr';
import {Settings} from './settings';
import {UUIDManager} from './util';
import {HMLogger} from './logger';
import { ZeroconfManager } from './zeroconf'; // Assuming Zeroconf might provide host/port

import {
  AudioData,
  ClientInfo,
  ClientEvent,
  ClientMessage,
  MediaPlayerId,
  Ping,
  HassmicCommand,
} from './proto/hassmic';

const Logger = new HMLogger('cheyenne.ts');

const RECONNECT_DELAY_MS = 5000; // Simple delay for now

type ConnectionStateType = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
type CallbackType<T> = ((s: T) => void) | null;

// Rename class
// "Cheyenne" protocol client (was server)
class CheyenneClient {
  // Keep track of the socket
  private _sock: TcpSocket.Socket | null = null;

  // Connection details (to be provided)
  private _host: string | null = null;
  private _port: number | null = null;

  // Reconnection timer
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _shouldReconnect: boolean = false; // Flag to control intentional disconnects vs errors

  // the UUID for this device
  private _uuid: string = '';

  // settable callback for connection state (true/false)
  private _connectionStateCallback: CallbackType<boolean> = null;
  // More detailed state tracking
  private _connectionState: ConnectionStateType = 'DISCONNECTED';

  // Whether the mic should be muted
  private _mic_muted: boolean = false;

  // NEW: Getter for connection state
  get isConnected(): boolean {
      return this._connectionState === 'CONNECTED';
  }

  setConnectionStateCallback = (cb: CallbackType<boolean>) => {
    this._connectionStateCallback = cb;
  };

  // Update internal state and call the simple true/false callback
  private _setConnectionState = (newState: ConnectionStateType) => {
    const wasConnected = this._connectionState === 'CONNECTED';
    this._connectionState = newState;
    const isConnected = newState === 'CONNECTED';

    // Only call the external callback if the connected state actually changes
    if (wasConnected !== isConnected) {
        Logger.info(`Connection state changed to ${newState}`);
        this._connectionStateCallback?.(isConnected);
    }
  };

  constructor() {
    NativeManager.addClientEventListener(async (ce: ClientEvent) => {
      // Sending ClientEvents remains the same conceptually
      // Ensure we only send when connected
      if (this._connectionState === 'CONNECTED') {
          Logger.debug(`Sending ClientEvent: ${ClientEvent.toJsonString(ce)}`);
          let cm = ClientMessage.create({
            msg: {
              oneofKind: 'clientEvent',
              clientEvent: ce,
            },
          });
          this.sendMessage(cm);
      } else {
          Logger.warn(`Not connected, dropping ClientEvent: ${ClientEvent.toJsonString(ce)}`);
      }
    });
  }

  sendMessage = (m: ClientMessage) => {
    // Logic is the same, just relies on _sock being the client socket
    if (this._sock && this._connectionState === 'CONNECTED') {
      try {
        let msg = ClientMessage.toBinary(m);
        let b64 = Buffer.from(msg).toString('base64');
        this._sock.write(b64 + '\\n');
      } catch (e: any) {
        Logger.error(`Error sending message: ${e.toString()}`);
        // Consider handling write errors more robustly (e.g., trigger disconnect/reconnect)
        this._handleDisconnect(true); // Treat send error as disconnect
      }
    }
  };

  sendInfo = (uuid: string) => {
    // Logic is the same
    try {
      this.sendMessage(
        ClientMessage.create({
          msg: {
            oneofKind: 'clientInfo',
            clientInfo: {
              uuid: uuid,
              version: APP_VERSION,
            },
          },
        }),
      );
    } catch (e: any) {
      Logger.error(`Error sending clientInfo: ${e}`);
    }
    try {
      let m = ClientMessage.create({
        msg: {
          oneofKind: 'savedSettings',
          savedSettings: Settings.getSavedSettings(),
        },
      });
      this.sendMessage(m);
    } catch (e: any) {
      Logger.error(`Error sending savedSettings: ${e}`);
    }
  };

  // Ping logic remains the same, uses the client socket
  // Need a way to stop the ping loop when disconnecting
  private _pingTimer: NodeJS.Timeout | null = null;
  startPing = () => {
    // Clear any existing timer first
    if (this._pingTimer) {
        clearTimeout(this._pingTimer);
        this._pingTimer = null;
    }

    const pingFn = () => {
      if (this._sock && this._connectionState === 'CONNECTED') {
        try {
          this.sendMessage(
            ClientMessage.create({
              msg: {
                oneofKind: 'ping',
                ping: {},
              },
            }),
          );
          // Schedule next ping
          this._pingTimer = setTimeout(pingFn, 10 * 1e3);
        } catch (e: any) {
          Logger.error(`Error sending ping: ${e.toString()}`);
          this._handleDisconnect(true); // Assume connection died
        }
      } else {
         Logger.debug('Ping loop stopped (socket closed or not connected).');
         this._pingTimer = null; // Ensure timer is cleared
      }
    };

    // Start the first ping immediately
    if (this._connectionState === 'CONNECTED') {
        pingFn();
    }
  };

  stopPing = () => {
      if (this._pingTimer) {
          clearTimeout(this._pingTimer);
          this._pingTimer = null;
          Logger.debug('Ping loop explicitly stopped.');
      }
  }

  // NEW: Connect method
  connect = async (host: string, port: number) => {
    // Prevent multiple concurrent connection attempts
    if (this._connectionState === 'CONNECTING' || this._connectionState === 'CONNECTED') {
        Logger.warn(`Connect called but already ${this._connectionState}. Ignoring.`);
        return;
    }

    // Store connection details for potential reconnections
    this._host = host;
    this._port = port;
    this._shouldReconnect = true; // Assume we want to reconnect on errors/closes

    // Clear any pending reconnect timer
    if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
    }

    Logger.info(`Attempting to connect to ${host}:${port}...`);
    this._setConnectionState('CONNECTING');

    // Ensure UUID is loaded before sending info
    if (!this._uuid) {
        this._uuid = await UUIDManager.getUUID();
    }

    try {
        // Ensure previous socket is destroyed before creating a new one
        this._sock?.destroy();
        this._sock = null;

        const socket = TcpSocket.createConnection({ host, port }, () => {
            // This callback executes on successful connection
            Logger.info(`Successfully connected to ${host}:${port}`);
            this._sock = socket; // Assign the connected socket
             this._setConnectionState('CONNECTED');

            // Set timeout and send initial info
            this._sock.setTimeout(60e3);
            this.sendInfo(this._uuid);
            this.startPing(); // Start ping loop now we are connected

            // Attach data handler AFTER assigning _sock
             this._sock.on('data', (d: string | Buffer) => {
                if (typeof d == 'string') {
                    this._handleIncomingData(
                        Uint8Array.from(Array.from(d).map(l => l.charCodeAt(0) || 0)),
                    );
                } else {
                    this._handleIncomingData(Uint8Array.from(d));
                }
            });

        });

        // Attach error/close handlers immediately after creation attempt
        socket.on('error', (err: any) => {
            Logger.error(`Connection error: ${err}`);
            // Don't nullify _sock here, _handleDisconnect will do it
            this._handleDisconnect(this._shouldReconnect);
        });

        socket.on('close', (hadError: boolean) => {
            Logger.info(`Connection closed.${hadError ? ' (Due to error)' : ''}`);
            // Don't nullify _sock here, _handleDisconnect will do it
             // Only reconnect if it wasn't an intentional disconnect OR if it closed due to an error
            this._handleDisconnect(this._shouldReconnect || hadError);
        });

        socket.on('timeout', () => {
            Logger.warn('Connection timed out.');
            // Don't nullify _sock here, _handleDisconnect will do it
            this._handleDisconnect(this._shouldReconnect); // Assume timeout means we should reconnect
        });

    } catch (e: any) {
         Logger.error(`Failed to initiate connection: ${e}`);
         this._handleDisconnect(this._shouldReconnect); // Trigger potential reconnect
    }
  };

  // NEW: Handle disconnect and schedule reconnection
  private _handleDisconnect = (reconnect: boolean) => {
      Logger.debug(`Handling disconnect. Reconnect: ${reconnect}`);

      // Clean up existing socket and ping timer
      if (this._sock) {
          // Remove listeners to prevent duplicate handling during cleanup
          this._sock.removeAllListeners();
          this._sock.destroy();
          this._sock = null;
      }
      this.stopPing();

      // Set state only if not already disconnected
      if(this._connectionState !== 'DISCONNECTED') {
        this._setConnectionState('DISCONNECTED');
      }


      // Clear any existing reconnect timer
      if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
      }

      // Schedule reconnection if needed
      if (reconnect && this._host && this._port) {
          Logger.info(`Scheduling reconnection in ${RECONNECT_DELAY_MS}ms...`);
          this._reconnectTimer = setTimeout(() => {
              // Check host/port again in case they changed while disconnected
              if (this._host && this._port) {
                 this.connect(this._host, this._port);
              } else {
                  Logger.warn('Reconnect scheduled but host/port missing.');
              }
          }, RECONNECT_DELAY_MS);
      } else {
          Logger.info('Not attempting reconnection.');
      }
  }

  // NEW: Disconnect method
  disconnect = () => {
    Logger.info('Disconnect called. Closing connection intentionally.');
    this._shouldReconnect = false; // Prevent automatic reconnection
     this._handleDisconnect(false); // Handle cleanup without scheduling reconnect
  };

  private _handleIncomingData = async (d: Uint8Array) => {
    // ... (existing _handleIncomingData implementation is mostly okay)
    // Ensure it checks this._connectionState === 'CONNECTED' before processing?
    // Maybe add more robust error handling around fromBinary
    Logger.debug(`Handling incoming data: ${d}`);
    if (this._connectionState !== 'CONNECTED') {
        Logger.warn('Received data while not connected. Ignoring.');
        return;
    }
    try {
      // compound statement does the following:
      //   1. Remove the last character in the incoming data (which should be a
      //      newline) using slice()
      //   2. Use Buffer.from(...).toString() to convert those bytes to a string
      //   3. Interpret that string back to bytes using base64 encoding
      //   4. Make a HassmicCommand from the resulting bytes

      // Protect against empty data causing slice errors
      if (d.length === 0) {
          Logger.warn('Received empty data packet.');
          return;
      }

      let m: HassmicCommand | null = null;
      try {
          m = HassmicCommand.fromBinary(
                Buffer.from(Buffer.from(d.slice(0, -1)).toString(), 'base64'),
            );
      } catch (protoError: any) {
          Logger.error(`Protobuf parsing error: ${protoError.toString()}`);
          Logger.error(`Failed data (string): ${Buffer.from(d).toString()}`);
           // Consider closing connection on severe parsing errors?
          return; // Stop processing this invalid data
      }


      switch (m.msg.oneofKind) {
        case 'setMicMute':
          Logger.info('Got set_mic_mute message');
          const shouldMute: boolean = m.msg.setMicMute;
          Logger.info(`Setting mic mute to ${shouldMute}`);
          this._mic_muted = shouldMute;
          break;
        // Actions that need to be handled by native code
        case 'playAudio':
        case 'setPlayerVolume':
        case 'command':
          Logger.debug(
            `Got "${m.msg.oneofKind}" HassmicCommand; passing it to native code`,
          );
          NativeManager.handleHassmicCommand(m);
          break;
        default:
          Logger.warning(`Got unknown message type '${m.msg.oneofKind}'`);
      }
    } catch (e: any) {
      Logger.error(`Error handling incoming data: ${e.toString()}`);
      Logger.error(`Data was: ${d}`);
    }
  };
}

// Update export name
export const CheyenneClientSocket: CheyenneClient = new CheyenneClient();
