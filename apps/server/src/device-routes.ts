import { DeviceRemove, DeviceRename, DeviceSettingsPatch, deviceSettings, type DeviceInfo, type DeviceList, type MyDeviceSettings } from "@masalapos/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DeviceRecord } from "./devices.js";

/**
 * The device list, renaming and removing a device, device history and each device's settings: what Settings → Devices
 * works with. Joining is in device-join.ts.
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

  const deviceId = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;

  // Renaming and removing also tell every screen (and close the removed device's sockets), as a licence change does.
  app.patch("/api/devices/:id", { preHandler: manage }, async (req, reply) => {
    const id = deviceId(req);
    const { name, version } = DeviceRename.parse(req.body);
    app.devices.rename(id, name, version, req.user.name);
    app.licensing.announceChange();
    reply.header("Cache-Control", "no-store");
    return { device: deviceList(req).devices.find((d) => d.id === id)! };
  });

  app.delete("/api/devices/:id", { preHandler: manage }, async (req, reply) => {
    const id = deviceId(req);
    const { version } = DeviceRemove.parse(req.body ?? {});
    app.devices.remove(id, req.user.name, version);
    app.licensing.announceChange();
    return reply.header("Cache-Control", "no-store").status(204).send();
  });

  app.get("/api/devices/events", { preHandler: manage }, async (req, reply) => {
    const { before } = z.object({ before: z.coerce.number().int().positive().safe().optional() }).parse(req.query);
    reply.header("Cache-Control", "no-store");
    return app.devices.events(before);
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
