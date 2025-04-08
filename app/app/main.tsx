import {
  Button,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  StyleSheet,
  StatusBar,
  Switch,
  Text,
  View,
} from "react-native";
import { APP_VERSION } from "./constants";
import { BackgroundTaskManager, TaskState } from "./backgroundtask";
import { CheyenneSocket } from "./cheyenne";
import { NetworkInfo } from "react-native-network-info";
import { UUIDManager } from "./util";
import { WyomingServer } from "./wyoming";
import { ZeroconfManager } from "./zeroconf";
import { Settings } from "./settings";
import { useState, useEffect, useRef } from "react";
import { SavedSettings } from "./proto/hassmic";

// note - patched version from
// https://github.com/jeffc/react-native-live-audio-stream
import LiveAudioStream from "react-native-live-audio-stream";

const Separator = () => (
  <View
    style={{
      marginVertical: 8,
      borderBottomColor: "#737373",
      borderBottomWidth: StyleSheet.hairlineWidth,
    }}
  />
);

const ANDROID_VERSION: number = +Platform.Version;

export default function Index() {
  const [hasAudioPermission, setHasAudioPermission] = useState(false);
  const [hasNotificationPermission, setHasNotificationPermission] = useState<
    boolean | null
  >(false);
  const [isCheyenneConnected, setIsCheyenneConnected] = useState(false);
  const [isWyomingConnected, setIsWyomingConnected] = useState(false);
  const [localIP, setLocalIP] = useState<string | null>("");
  const [isBackgroundTaskEnabled, setBackgroundTaskEnabled] = useState(false);
  const [backgroundTaskState, setBackgroundTaskState] = useState(
    TaskState.UNKNOWN
  );
  const [uuid, setUUID] = useState("");

  // Ref to track if initial setup effect has run
  const initialSetupDone = useRef(false);

  // check audio permission silently
  const checkAudioPermission = async (): Promise<boolean> => {
    const audio_ok = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    );
    setHasAudioPermission(audio_ok);
    return audio_ok;
  };

  // check notification permission silently
  const checkNotificationPermission = async (): Promise<boolean | null> => {
    if (ANDROID_VERSION < 33) {
      // notification permission does not exist before API 33
      setHasNotificationPermission(null);
      return null;
    }
    const notify_ok = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
    );
    setHasNotificationPermission(notify_ok);
    return notify_ok;
  };

  // ask for permissions, if need
  const requestPermissions = async () => {
    const audio_ok = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
    );
    setHasAudioPermission(audio_ok == PermissionsAndroid.RESULTS.GRANTED);
    console.log(`Audio permission: ${audio_ok}`);

    const notif_ok =
      ANDROID_VERSION < 33
        ? null
        : await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
          );
    setHasNotificationPermission(
      ANDROID_VERSION < 33
        ? null
        : notif_ok == PermissionsAndroid.RESULTS.GRANTED
    );
    console.log(`Notify permission: ${notif_ok}`);
  };

  const stopStream = async () => {
    LiveAudioStream.stop();
  };

  const settingsUpdated = async (newSettings: SavedSettings) => {
    setUUID(newSettings.hassmicUuid);
  };

  // useEffect(..., []) for initial setup on component mount
  useEffect(() => {
    // Prevent running twice in StrictMode or due to remounts
    if (initialSetupDone.current) {
        return;
    }
    initialSetupDone.current = true;

    console.log("[main.tsx] Running initial setup useEffect...");

    // Setup callbacks
    CheyenneSocket.setConnectionStateCallback(setIsCheyenneConnected);
    WyomingServer.setConnectionStateCallback(setIsWyomingConnected);
    NetworkInfo.getIPV4Address().then(setLocalIP);
    Settings.registerSettingsChangedCallback(settingsUpdated);

    // Kill any potentially orphaned background task on app startup
    console.log("[main.tsx] Killing orphaned background task (if any)...");
    BackgroundTaskManager.kill();

    // Register callbacks to get current state from the manager
    BackgroundTaskManager.setEnableStateCallback(setBackgroundTaskEnabled);
    BackgroundTaskManager.setTaskStateCallback(setBackgroundTaskState);

    // Check permissions
    checkAudioPermission().then((ok) => {
      setHasAudioPermission(ok);
      console.log(`[main.tsx] Initial Audio Permission: ${ok}`);
    });
    checkNotificationPermission().then((ok) => {
      setHasNotificationPermission(ok);
      console.log(`[main.tsx] Initial Notification Permission: ${ok}`);
    });

    // IMPORTANT: Empty dependency array ensures this runs only once on mount
  }, []);

  // useEffect to react to changes in the background task enabled state
  useEffect(() => {
    // Don't run this effect until initial setup is complete
    if (!initialSetupDone.current) {
      return;
    }

    console.log(
      `[main.tsx] useEffect [isBackgroundTaskEnabled] triggered. Enabled: ${isBackgroundTaskEnabled}, State: ${TaskState[backgroundTaskState]}`,
    );

    if (isBackgroundTaskEnabled) {
      // Only call run() if the task is definitively STOPPED or UNKNOWN.
      // Let the BackgroundTaskManager itself handle the STARTING/RUNNING/FAILED checks internally.
      if (
        backgroundTaskState === TaskState.STOPPED ||
        backgroundTaskState === TaskState.UNKNOWN
      ) {
        console.log(
          `[main.tsx] Background task enabled and stopped/unknown. Calling BackgroundTaskManager.run()...`,
        );
        BackgroundTaskManager.run();
      } else {
        console.log(
          `[main.tsx] Background task enabled but state is ${TaskState[backgroundTaskState]}. No action needed from main.tsx.`,
        );
      }
    } else {
      // Only kill if it's currently running or potentially starting
      if (
        backgroundTaskState === TaskState.RUNNING ||
        backgroundTaskState === TaskState.STARTING
      ) {
        console.log(
          `[main.tsx] Background task disabled and running/starting. Calling BackgroundTaskManager.kill()...`,
        );
        BackgroundTaskManager.kill();
      } else {
        console.log(
          `[main.tsx] Background task disabled but state is ${TaskState[backgroundTaskState]}. No action needed from main.tsx.`,
        );
      }
    }
    // Dependency array includes backgroundTaskState now to react to state changes if enabling fails
  }, [isBackgroundTaskEnabled, backgroundTaskState]);

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <StatusBar backgroundColor="#000000" />
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <>
          {hasAudioPermission ? null : (
            <View>
              <Button title="Get Permissions" onPress={requestPermissions} />
            </View>
          )}
          <View
            style={{
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "row",
            }}
          >
            <Text
              style={{
                fontSize: 24,
              }}
            >
              Enable running in background:{" "}
            </Text>
            <Switch
              onValueChange={BackgroundTaskManager.setEnabled}
              value={isBackgroundTaskEnabled}
              disabled={!hasAudioPermission}
            />
          </View>
          <View
            style={{
              borderBottomColor: "black",
              borderBottomWidth: 1,
              height: 10,
            }}
          />
          <Text>
            Background Task: {isBackgroundTaskEnabled ? "enabled" : "disabled"}{" "}
            and{" "}
            {backgroundTaskState == TaskState.RUNNING
              ? "running"
              : "not running"}
          </Text>
          <Text>Local IP: {localIP}</Text>
          <Text>Device Unique ID: {uuid}</Text>
          <Text>Wyoming Connected: {isWyomingConnected ? "yes" : "no"}</Text>
          <Text>
            HassMic Integration Connected: {isCheyenneConnected ? "yes" : "no"}
          </Text>
          <Text>
            Permission to record audio: {hasAudioPermission ? "yes" : "no"}
          </Text>
          <Text>
            Permission to show notification:{" "}
            {hasNotificationPermission === null
              ? "not required"
              : hasNotificationPermission
                ? "yes"
                : "no"}
          </Text>
          <Text>Version {APP_VERSION}</Text>
        </>
      </View>
    </SafeAreaView>
  );
}
