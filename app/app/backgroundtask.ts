import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppRegistry, NativeEventEmitter, NativeModules} from 'react-native';
import {Buffer} from 'buffer';
import {CheyenneSocket} from './cheyenne';
import {HMLogger} from './logger';
import {NativeManager} from './nativemgr';
import {PermissionsAndroid} from 'react-native';
import {Settings} from './settings';
import {STORAGE_KEY_RUN_BACKGROUND_TASK, AUDIO_INFO} from './constants';
import {WyomingServer} from './wyoming';
import {ZeroconfManager} from './zeroconf';

// note - patched version from
// https://github.com/jeffc/react-native-live-audio-stream
import LiveAudioStream from 'react-native-live-audio-stream';

const Logger = new HMLogger('backgroundtask.ts');

// Get reference to the native modules
const {WakeWordModule, BackgroundTaskModule: NativeBackgroundTaskModule} = NativeModules;
// Create an event emitter for the wake word module
const wakeWordEventEmitter = new NativeEventEmitter(WakeWordModule);

const sleep = (delay: number) =>
  new Promise(resolve => setTimeout(resolve, delay));

// Convenience type for a generic callback
type CallbackType<T> = (s: T) => void;

export enum TaskState {
  // no info
  UNKNOWN,

  // Task is initiating startup
  STARTING,

  // task tried to start but failed
  FAILED,

  // task is running
  RUNNING,

  // task is not running (on purpose)
  STOPPED,
}

class BackgroundTaskManager_ {
  // track the task state
  private taskState: TaskState = TaskState.UNKNOWN;
  private isTranscribing: boolean = false; // Track if LiveAudioStream should be running for Wyoming

  // Flag to prevent re-entrancy in run_fn
  private isStarting = false;

  // convenience function: sets the state and calls the callback
  private setState = (s: TaskState) => {
    // Prevent setting RUNNING if initialization failed
    if (s === TaskState.RUNNING && this.taskState === TaskState.FAILED) {
      Logger.warn("Attempted to set state to RUNNING after failure. Keeping FAILED.");
      return;
    }
    Logger.debug(`Setting TaskState to: ${TaskState[s]}`);
    this.taskState = s;
    this.taskStateCallback(s);
  };

  // callback for when the task state changes
  private taskStateCallback: CallbackType<TaskState> = (s: TaskState) => {};

  // callback setter
  // calls callback immediately with current state when set
  setTaskStateCallback = (f: CallbackType<TaskState> | null) => {
    if (f) {
      this.taskStateCallback = f;
      f(this.taskState); // Call immediately with current state
    } else {
      this.taskStateCallback = (s: TaskState) => {};
    }
  };

  // track enable state
  private isEnabled: Promise<boolean> = new Promise<boolean>(
    (resolve, reject) => { // Use reject for consistency
      (async () => {
        let en_str: string | null = null;
        try {
          en_str = await AsyncStorage.getItem(STORAGE_KEY_RUN_BACKGROUND_TASK);
        } catch (e) {
          Logger.error(`Error getting task enable state: ${e}`);
          reject(e); // Reject the promise on error
          return;
        }

        let en: boolean = en_str === 'true';
        if (en_str === null) {
          Logger.debug('No enable state found. Defaulting to false.');
          en = false;
          // Optionally save the default state back
          // await AsyncStorage.setItem(STORAGE_KEY_RUN_BACKGROUND_TASK, 'false');
        }
        resolve(en);
      })();
    },
  );

  // callback for when the enable state is changed or set
  private enableStateCallback: CallbackType<boolean> = (b: boolean) => {};

  // callback setter
  // once enable state is known, calls callback
  setEnableStateCallback = (f: CallbackType<boolean> | null) => {
    const callback = f || ((b: boolean) => {});
    this.enableStateCallback = callback;
    // Call immediately if promise is already resolved, otherwise wait
    this.isEnabled.then(callback).catch(err => {
        Logger.error("Failed to get initial enabled state for callback", err);
        // Decide default state for callback if needed, e.g., callback(false)
    });
  };

  // enable or disable the task
  setEnabled = (enable: boolean) => {
    const newStateStr = enable ? 'true' : 'false';
    AsyncStorage.setItem(STORAGE_KEY_RUN_BACKGROUND_TASK, newStateStr)
      .then(() => {
        this.isEnabled = Promise.resolve(enable);
        this.enableStateCallback(enable);
         Logger.info(`Background task ${enable ? 'enabled' : 'disabled'}`);
         if (!enable && (this.taskState === TaskState.RUNNING || this.taskState === TaskState.STARTING)) {
             this.stop(); // Stop the task if it was running/starting and gets disabled
         }
      })
      .catch((e) => {
        Logger.error(`Error saving enable state: ${e}`);
        // Revert optimistic update? Or notify user?
        this.isEnabled = Promise.reject(e); // Reflect the error state
      });
  };

  // Listener subscription
  private wakeWordSubscription: any = null; // Using 'any' for simplicity, replace with EmitterSubscription if possible
  private wakeWordErrorSubscription: any = null;

  // Setup listener for wake word events
  setupWakeWordListener = () => {
    if (this.wakeWordSubscription || this.wakeWordErrorSubscription) {
        Logger.debug("Wake word listeners already set up.");
        return; // Already subscribed
    }
    Logger.debug("Setting up wake word listeners...");

    this.wakeWordSubscription = wakeWordEventEmitter.addListener(
      'onWakeWordDetected',
      (event: { modelName: string; score: number }) => {
        Logger.info(
          `Wake word detected: ${event.modelName} (score: ${event.score})`,
        );
        
        if (this.isTranscribing) {
            Logger.warn("Wake word detected while already transcribing, ignoring.");
            return;
        }

        // --- Start Wyoming Transcription Flow ---
        Logger.info('Starting Wyoming transcription flow...');
        this.isTranscribing = true;

        // 1. Potentially play wake sound (Phase 3 feature)
        // playWakeSound();

        // 2. Stop LiveAudioStream if it happens to be running (shouldn't be in Option B)
        // LiveAudioStream.stop(); // Belt-and-suspenders, likely no-op here

        // 3. Signal WyomingServer to start transcription
        WyomingServer.startTranscription(); // Assuming this method exists and sends the 'transcribe' event

        // 4. Initialize and Start LiveAudioStream *for Wyoming*
        // Ensure it's initialized if not already (might need one-time init)
        LiveAudioStream.init({
            sampleRate: AUDIO_INFO.rate,
            channels: AUDIO_INFO.channels,
            bitsPerSample: AUDIO_INFO.width * 8,
            audioSource: 6, // TODO: Verify this source works with WakeWordModule's use of MIC
            wavFile: '', 
        });
        // Start streaming to Wyoming
        LiveAudioStream.start();
        Logger.info('LiveAudioStream started for Wyoming transcription.');

        // 5. Add mechanism to stop transcription
        // We need a signal from WyomingServer when interaction ends (e.g., TTS finishes or error occurs)
        // Let's assume WyomingServer has a callback or event for this:
        // WyomingServer.onInteractionEnd = () => { this.stopWyomingTranscriptionStream(); }; 
        // OR listen for specific Wyoming events (like 'audio-stop' or error)

      },
    );

    this.wakeWordErrorSubscription = wakeWordEventEmitter.addListener(
        'onWakeWordError',
        (error: { code?: string; message?: string }) => {
            Logger.error(`Wake word error: Code: ${error.code || 'N/A'}, Message: ${error.message || 'Unknown error'}`);
            // Decide how to handle errors, e.g., try restarting?
            // Maybe stop detection and set state to FAILED?
            this.stopWakeWordDetectionInternal(); // Attempt to stop native module
            this.setState(TaskState.FAILED); 
        }
    );
  };

  // Function to stop the audio stream to Wyoming
  stopWyomingTranscriptionStream = () => {
      if (!this.isTranscribing) {
          return; // Already stopped
      }
      Logger.info("Stopping Wyoming transcription stream...");
      LiveAudioStream.stop();
      this.isTranscribing = false;
      // Signal WyomingServer transcription ended (if needed)
      // WyomingServer.endTranscription();
  };

  // Remove listeners
  removeWakeWordListeners = () => {
    if (this.wakeWordSubscription) {
        Logger.debug("Removing wake word listener.");
        this.wakeWordSubscription.remove();
        this.wakeWordSubscription = null;
    }
    if (this.wakeWordErrorSubscription) {
        Logger.debug("Removing wake word error listener.");
        this.wakeWordErrorSubscription.remove();
        this.wakeWordErrorSubscription = null;
    }
  };

  // Call the native stop method internally, handling potential null instance
  private stopWakeWordDetectionInternal = () => {
    if (NativeBackgroundTaskModule) {
      NativeBackgroundTaskModule.stopWakeWordDetection()
        .then((msg: string) => Logger.info(`Native stopWakeWordDetection result: ${msg}`))
        .catch((err: any) => Logger.error("Error calling native stopWakeWordDetection", err));
    } else {
      Logger.warn("NativeBackgroundTaskModule not available to stop wake word detection.");
    }
  };

  // actually run the task
  run_fn = async (taskData: any) => {
    // Prevent multiple simultaneous runs and runs while already running/starting
    if (this.isStarting || this.taskState === TaskState.RUNNING || this.taskState === TaskState.STARTING) {
      Logger.warn(
        `run_fn called but already starting/running. Current state: ${TaskState[this.taskState]}, isStarting: ${this.isStarting}`,
      );
      return;
    }

    this.isStarting = true; // Set starting flag
    this.setState(TaskState.STARTING); // Set STARTING state

    try { // Wrap core logic in try/finally to ensure isStarting is reset
      await NativeManager.waitForReady();
      await Settings.waitForReady();

      const shouldRun = await this.isEnabled;

      if (!shouldRun) {
        Logger.info('Not running background task; is disabled');
        this.setState(TaskState.STOPPED);
        NativeManager.killService();
        this.isStarting = false; // Reset flag
        return;
      }

      Logger.info('Started background task process...');
      const shouldStop = new Promise<void>((resolve) => {
        this.stop_fn = resolve;
      });

      // Setup wake word listener *before* starting native module
      this.setupWakeWordListener();

      // native event listeners
      CheyenneSocket.startServer();
      Logger.info('Started cheyenne server');

      WyomingServer.startServer(); // Starts WebSocket, but doesn't necessarily trigger audio yet
      Logger.info('Started wyoming server');

      await ZeroconfManager.StartZeroconf();
      const ok = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      if (!ok) {
        Logger.error('RECORD_AUDIO no permission; bailing');
        this.setState(TaskState.FAILED);
        this.removeWakeWordListeners();
        this.isStarting = false; // Reset flag
        return;
      }
      Logger.info('RECORD_AUDIO permission okay');

      // Attempt to start native wake word detection
      Logger.info('Attempting to start native wake word detection...');
      try {
        await NativeBackgroundTaskModule.startWakeWordDetection();
        Logger.info('Native wake word detection started via bridge.');
      } catch (e) {
        Logger.error(
          'Failed to start native wake word detection:',
          e instanceof Error ? e.message : e,
        );
        this.setState(TaskState.FAILED);
        this.removeWakeWordListeners();
        // Potentially kill service if start failed?
        // NativeManager.killService();
        this.isStarting = false; // Reset flag
        return; // Exit if WWM fails to start
      }

      // If we reached here, native module started (or at least didn't throw immediately)
      this.setState(TaskState.RUNNING);
      Logger.info(
        'Background task running (with wake word detection active), awaiting stop signal',
      );

      await shouldStop; // Wait for stop signal

      // --- Cleanup --- 
      Logger.info('Background task got stop signal, stopping');
      this.removeWakeWordListeners();

      // Attempt to stop native wake word detection
      try {
          Logger.info('Attempting to stop native wake word detection...');
          await NativeBackgroundTaskModule.stopWakeWordDetection();
          Logger.info('Native wake word detection stopped via bridge.');
      } catch(e) {
          Logger.error(
            'Failed to stop native wake word detection:',
            e instanceof Error ? e.message : e,
          );
      }

      WyomingServer.stopServer();
      CheyenneSocket.stopServer();
      NativeManager.killService(); // This should trigger WakeWordModule.stop() via service onDestroy
      ZeroconfManager.StopZeroconf();
      this.setState(TaskState.STOPPED);

    } catch (error) {
        Logger.error('Error during background task run_fn:', error);
        this.setState(TaskState.FAILED);
        // Ensure listeners are removed on unexpected error
        this.removeWakeWordListeners(); 
        // Attempt cleanup
        try {
             NativeBackgroundTaskModule.stopWakeWordDetection().catch(() => {}); // Best effort stop
        } catch {}
        NativeManager.killService();

    } finally {
        this.isStarting = false; // ALWAYS reset starting flag
    }
  };

  // stop_fun is set by run() to the resolver on a promise. run() then runs
  // until that promise is fulfilled.
  private stop_fn: (() => void) | null = null;

  // stop the current run by resolving the promise using stop_fn.
  stop = () => {
    if (this.stop_fn) {
      this.stop_fn();
    } else {
      Logger.error(
        "Called stop() on background task, but it doesn't appear to be running",
      );
    }
  };

  // kill any existing instance of the task - just calls stopService
  kill = () => {
    NativeManager.killService();
  };

  // start the task - just calls startService
  run = () => {
      if (this.isStarting || this.taskState === TaskState.RUNNING || this.taskState === TaskState.STARTING) {
          Logger.warn(`run() called but task already starting/running. State: ${TaskState[this.taskState]}, isStarting: ${this.isStarting}`);
          return; // Prevent calling NativeManager.runService unnecessarily
      }
      Logger.info("BackgroundTaskManager.run() calling NativeManager.runService()");
      NativeManager.runService();
  };
}

export const BackgroundTaskManager = new BackgroundTaskManager_();
