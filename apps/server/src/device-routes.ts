import { DeviceSettingsPatch, deviceSettings, type DeviceInfo, type DeviceList, type MyDeviceSettings } from "@masalapos/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DeviceRecord } from "./devices.js";

/**
 * The device list and each device's settings. Joining is in device-join.ts. Renaming and removing a device still go
 * through /api/license/devices until the Devices area replaces those routes.
 */
export function registerDevices(app: FastifyInstance): void {
  const manage = app.requirePermission("settings.manage");
  const deviceList = (req: FastifyRequest): DeviceList => {
    const maxDevices = app.licensing.status().maxDevices;
    const info = (device: DeviceRecord, index: number): DeviceInfo => ({
      id: device.id, kind: device.kind, name: device.name, isMain: device.isMain, createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt, version: device.version,
      current: device.id === req.device?.id, allowed: maxDevices === null || index < maxDevices,
      online: app.deviceOnline(device.id), settings: app.devices.settings(device), printerInactive: app.devices.printerInactive(device),
    });
    return { devices: app.devices.active().map(info), maxDevices };
  };

  app.get("/api/devices", { preHandler: manage }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return deviceList(req);
  });

  app.patch("/api/devices/:id/settings", { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { version, ...patch } = DeviceSettingsPatch.parse(req.body);
    const saved = app.devices.updateSettings(id, patch, version, req.user.name);
    // The device re-reads its settings; a save that changed nothing tells nobody.
    if (saved.version !== version) app.broadcast("devices.changed", { deviceId: id });
    return { device: deviceList(req).devices.find((d) => d.id === id)! };
  });

  // What the calling device works with now: a saved printer that has been switched off reads as none, the same answer
  // the bill routes give, so the counter never offers a print that will not happen.
  app.get("/api/devices/me/settings", { preHandler: app.requireAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const device = req.device;
    if (!device) return { deviceId: null, version: null, printerInactive: false, settings: deviceSettings({}) } satisfies MyDeviceSettings;
    return { deviceId: device.id, version: device.version, printerInactive: app.devices.printerInactive(device),
      settings: { ...app.devices.settings(device), billPrinterId: app.devices.billPrinterId(device) } } satisfies MyDeviceSettings;
  });
}
