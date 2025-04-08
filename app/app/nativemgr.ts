// Handles and abstracts away interactions with native java code

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
// Ensure BackgroundTaskModule is correctly referenced
const BackgroundTaskModule = NativeModules.BackgroundTaskModule;
import { Buffer } from 'buffer';
import { CLIENT_EVENT_KEY, STORAGE_KEY_SAVED_SETTINGS_PROTO } from './constants';
import { HMLogger } from './logger';
import { Settings } from './settings';
import {
  ClientEvent,
  ClientMessage,
  MediaPlayerId,
  SavedSettings,
  HassmicCommand,
} from './proto/hassmic';

const Logger = new HMLogger('nativemgr.ts');

// Helper to get the module, handling potential null
const getBackgroundTaskModule = () => {
  if (!BackgroundTaskModule) {
    Logger.error("NativeModules.BackgroundTask is null. Check native module registration and linking.");
  }
  return BackgroundTaskModule;
}

class NativeManager_ {
  // Initialize emitter lazily after ensuring the module exists
  private _emitter: NativeEventEmitter | null = null;
  private get emitter(): NativeEventEmitter | null {
      const module = getBackgroundTaskModule();
      if (module && !this._emitter) {
          this._emitter = new NativeEventEmitter(module);
      }
      return this._emitter;
  }

  // use a promise to be able to flag when everything is initialized.
  private setReady: () => void = () => {};
  private ready_: Promise<void> | null = null;

  constructor() {
    this.ready_ = new Promise<void>((resolve) => {
      this.setReady = resolve;
    });
    // run async init
    this.initialize_().then(
      (ok) => Logger.debug('Init ok'),
      (nok) => Logger.debug(`Init not ok: ${nok}`),
    );
  }

  // perform async initializiations
  private initialize_ = async () => {
    // Ensure module is available before adding listener
    if (this.emitter) {
        this.addClientEventListener(this.onClientEvent);
        Logger.debug('Native manager is ready.');
        this.setReady();
    } else {
        // Retry or handle error if module is persistently null
        Logger.error("Failed to initialize NativeEventEmitter: BackgroundTaskModule is null.");
        // Consider adding a retry mechanism or reporting a fatal error
    }
  };

  waitForReady = async () => {
    await this.ready_;
  };

  // Add a listener for ClientEvents sent by native code.
  addClientEventListener = (f: (ev: ClientEvent) => Promise<void>) => {
    const currentEmitter = this.emitter;
    if (!currentEmitter) {
        Logger.error("Cannot add listener: NativeEventEmitter is not initialized.");
        return;
    }
    currentEmitter.addListener(CLIENT_EVENT_KEY, async (ev) => {
      Logger.debug(`Proto-valued event: "${ev}"`);
      try {
        let ce = ClientEvent.fromBinary(
          //Buffer.from(Buffer.from(ev.slice(0, -1)).toString(), 'base64'),
          Buffer.from(Buffer.from(ev).toString(), 'base64'),
        );
        await f(ce);
      } catch (e) {
        Logger.error(`Error in ClientEvent Listener: ${e}`);
      }
    });
  };

  // Process a message that needs to be handled by native code
  handleHassmicCommand(hm: HassmicCommand) {
    const module = getBackgroundTaskModule();
    if (!module) return;

    let hmb64: string = Buffer.from(HassmicCommand.toBinary(hm)).toString(
      'base64',
    );
    module.handleHassmicCommand(hmb64);
  }

  // kill any existing instance of the task
  killService = () => {
    const module = getBackgroundTaskModule();
    if (!module) return;
    try {
      // Check if stopService exists before calling
      if (module.stopService) {
          module.stopService();
      } else {
          Logger.warn("Native BackgroundTaskModule does not have stopService method.");
      }
    } catch (e) {
        Logger.error(`Error calling stopService: ${e}`);
    }
  };

  // start the task
  runService = () => {
    const module = getBackgroundTaskModule();
    if (!module) return;

    // Check if startService exists before calling
    if (module.startService) {
        module.startService();
    } else {
        Logger.error("Native BackgroundTaskModule does not have startService method.");
    }
  };

  // What to do on ClientEvent receipt from native code
  private onClientEvent = async (ce: ClientEvent) => {
    Logger.info(ClientEvent.toJsonString(ce));
    if (ce.event.oneofKind == 'mediaPlayerVolumeChange') {
      const vl = ce.event.mediaPlayerVolumeChange;
      switch (vl.player) {
        case MediaPlayerId.ID_ANNOUNCE:
          Logger.debug(`Setting new volume level for announce to ${vl.volume}`);
          Settings.setAnnounceVolume(vl.volume).then(() => {});
          break;
        case MediaPlayerId.ID_PLAYBACK:
          Logger.debug(`Setting new volume level for playback to ${vl.volume}`);
          Settings.setPlaybackVolume(vl.volume).then(() => {});
          break;
        default:
          Logger.error(`Unknown player in event: ${vl.player}`);
      }
    }
  };
}

export const NativeManager: NativeManager_ = new NativeManager_();
