import { writeCsv } from "../lib/csv-writer";

export async function exportOrders(pluginPath: string): Promise<unknown[]> {
  const domain = await import("../domain/order");
  const plugin: { run(): unknown } = await import(pluginPath);
  return [writeCsv([]), domain.orderTotal({ id: "x", total: 1 }), plugin.run()];
}
