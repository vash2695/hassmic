import Zeroconf from "react-native-zeroconf";

import { HASSMIC_PORT, WYOMING_PORT } from "./constants";
import { Settings } from "./settings";
import { HMLogger } from "./logger";

const Logger = new HMLogger("zeroconf.ts");

// Define the type for the callback function
type HassMicFoundCallback = (host: string, port: number) => void;

class ZeroconfManager_ {
  zeroconf = new Zeroconf();
  private _hassMicFoundCallback: HassMicFoundCallback | null = null;
  private _discoveredServiceKey: string | null = null; // Keep track of what we found to avoid duplicates

  // Setter for the callback
  setHassMicFoundCallback = (callback: HassMicFoundCallback) => {
      this._hassMicFoundCallback = callback;
  }

  StartZeroconf = async () => {
    let zcuuid: string = await Settings.getHMUUID();

    // Stop previous scans/publications first to be safe
    this.StopZeroconf(); // Call the async stop, but don't necessarily wait

    // ---- Publishing (Existing Logic) ----
    Logger.debug(`Starting HM Zeroconf publishing using UUID ${zcuuid}`);
    this.zeroconf.publishService(
      "hassmic",
      "tcp",
      "local.",
      zcuuid, // Use UUID as instance name for client service
      HASSMIC_PORT // Publish the port *this* client might listen on (if needed later)
    );

    Logger.debug(`Starting Wyoming Zeroconf publishing using UUID ${zcuuid}`);
    this.zeroconf.publishService(
      "wyoming",
      "tcp",
      "local.",
      "wy-" + zcuuid, // Instance name for Wyoming service
      WYOMING_PORT // Publish the port Wyoming listens on
    );

    // ---- Scanning/Discovery (New Logic) ----
    Logger.info('Starting Zeroconf scan for HassMic server (_hassmic._tcp.local.)...');
    this._discoveredServiceKey = null; // Reset discovery state

    // Remove existing listeners before adding new ones
    this.zeroconf.removeDeviceListeners();

    this.zeroconf.on('error', (err: any) => {
        Logger.error(`Zeroconf Error: ${err}`);
        // Consider adding more robust error handling/retry logic
    });

    this.zeroconf.on('stop', () => {
        Logger.info('Zeroconf scan stopped.');
    });

    this.zeroconf.on('found', (service: any) => {
        // Note: 'found' might only give basic info. We often need 'resolved'.
        // Check if this service name looks like the one we want
        // (Adjust the check based on actual HA integration naming)
        Logger.debug(`Zeroconf Found: ${service.name} (${service.host})`);
        Logger.info(`Zeroconf Raw 'found' event data: ${JSON.stringify(service)}`);
    });

    this.zeroconf.on('resolved', (service: any) => {
        Logger.info(`Zeroconf Resolved: ${JSON.stringify(service)}`);

        // Check if it's the correct service type we are scanning for
        // The library might implicitly filter by type, but let's be explicit if needed
        // Assuming the scan targets `_hassmic._tcp.local.` implicitly
        if (service.host && service.port && service.addresses && service.addresses.length > 0) {
            // Log details for debugging, regardless of name for now
            Logger.info(`Resolved a service: Name='${service.name}', Type='${service.type}', Domain='${service.domain}', Host='${service.host}', Port=${service.port}, Addresses=${service.addresses}`);

            // Check if it's the service we want (adjust check as needed based on logs)
            // Let's assume the *instance name* might be based on the HA instance or device name, 
            // but the *type* is what we scanned for. For now, let's try connecting to the *first* one found.
            // TODO: Add better logic to select the correct HA instance if multiple are found.
            if (!this._discoveredServiceKey) { // Connect only to the first one we resolve
                // Prioritize IPv4 if available
                const ipv4Address = service.addresses.find((addr: string) => addr.includes('.'));
                const host = ipv4Address || service.addresses[0]; // Fallback to first address
                const port = service.port;
                const key = `${host}:${port}`; // Use host:port as a temporary key

                // Use a more descriptive log message
                Logger.info(`Found potential HassMic service instance '${service.name}' at ${host}:${port}. Attempting connection.`);
                this._discoveredServiceKey = key; // Mark as found/attempted

                // Trigger the callback to connect Cheyenne
                if (this._hassMicFoundCallback) {
                    this._hassMicFoundCallback(host, port);
                } else {
                    Logger.warn('HassMic service found, but no callback was set to handle it.');
                }
                // Stop scanning once we found one? Maybe not yet, allow for changes.
                // this.zeroconf.stop();
            }
            // else: Already found/connected to a service, ignore subsequent resolutions for now
        }
    });

    this.zeroconf.on('remove', (serviceName: string) => {
        Logger.info(`Zeroconf Removed: ${serviceName}`);
        // TODO: If the removed service is the one we were connected to,
        // trigger a disconnect in Cheyenne and potentially restart the scan
        // if (serviceName corresponds to this._discoveredServiceKey) { ... }
    });

    // Start scanning for the specific service type
    this.zeroconf.scan('hassmic', 'tcp', 'local.');
  };

  StopZeroconf = async () => {
    Logger.info('Stopping Zeroconf publication and scan...');
    this.zeroconf.stop(); // Stop scanning
    this.zeroconf.removeDeviceListeners(); // Clean up listeners

    // Unpublish services (existing logic)
    try {
        let zcuuid: string = await Settings.getHMUUID();
        Logger.debug(`Unpublishing services for UUID ${zcuuid}`);
        this.zeroconf.unpublishService(zcuuid); // Instance name for client
        this.zeroconf.unpublishService("wy-" + zcuuid); // Instance name for Wyoming
    } catch (e) {
        Logger.error(`Error getting UUID for unpublish: ${e}`);
    }

    this._discoveredServiceKey = null; // Reset discovery state
  };
}

export const ZeroconfManager: ZeroconfManager_ = new ZeroconfManager_();
