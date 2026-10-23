import {
  HDR_RENDERING_TABLES_VERSION,
  prepareHdrRenderingTableData,
} from '../../../shared/hdr-rendering-tables'
self.onmessage = ({ data }: MessageEvent<{ version: string }>) => {
  try {
    if (data.version !== HDR_RENDERING_TABLES_VERSION)
      throw new Error('Fixed HDR rendering table version does not match.')
    const tables = prepareHdrRenderingTableData()
    self.postMessage(tables, {
      transfer: [tables.packed.buffer, tables.sdr.srgb.buffer, tables.sdr['display-p3'].buffer],
    })
  } catch (error) {
    self.postMessage({ error: String(error) })
  }
}
