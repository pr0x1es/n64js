import { Device } from './device.js';
import { toString32 } from '../format.js';
import * as logger from '../logger.js';

export class MappedMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("VMEM", hardware, hardware.ram, rangeStart, rangeEnd);
  }

  calcInternalEA(address) {
    // FIXME: why do we mask against this value?
    // If the access is outside of ram we should handle the same as InvalidMemDevice.
    return n64js.cpu0.translateReadInternal(address) & 0x007fffff;
  }

  calcReadEA(address) {
    // FIXME: why do we mask against this value?
    // If the read is outside of ram we should handle the same as InvalidMemDevice.
    return n64js.cpu0.translateRead(address) & 0x007fffff;
  }

  calcWriteEA(address) {
    // FIXME: why do we mask against this value?
    // If the write is outside of ram we should handle the same as InvalidMemDevice.
    return n64js.cpu0.translateWrite(address) & 0x007fffff;
  }
}


export class CachedMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("RAM", hardware, hardware.ram, rangeStart, rangeEnd);

    // Used by n64js.getRamS32Array.
    this.dataView = this.mem.dataView;
    this.s32 = new Int32Array(this.mem.arrayBuffer);
  }

  // Provide specialised implementations for some hot functions - hard-code some calcuations for performance.
  readU32(address) {
    const off = address - 0x80000000;
    return this.dataView.getUint32(off, false); 
  }

  readS32(address) {
    const off = address - 0x80000000;
    return this.dataView.getInt32(off, false); 
  }

  write32(address, value) {
    const off = address - 0x80000000;
    this.dataView.setUint32(off, value, false); 
  }
}

export class UncachedMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("RAM", hardware, hardware.ram, rangeStart, rangeEnd);
  }
}

export class InvalidMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("Invalid", hardware, null, rangeStart, rangeEnd);
  }

  read(address) {
    logger.log(`Reading from invalid address ${toString32(address)}`);
    return 0;
  }

  write(address) {
    logger.log(`Writing to invalid address ${toString32(address)}`);
  }

  readU32(address) { return this.read(address) >>> 0; }
  readU16(address) { return this.read(address) & 0xffff; };
  readU8(address) { return this.read(address) & 0xff; };

  readS32(address) { return this.read(address) >> 0; }
  readS16(address) { return this.read(address) & 0xffff; };
  readS8(address) { return this.read(address) & 0xff; };

  write32(address, value) { this.write(address, value); };
  write16(address, value) { this.write(address, value); };
  write8(address, value) { this.write(address, value); };
}

export class RDRamRegDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("RDRAMReg", hardware, hardware.rdram_reg, rangeStart, rangeEnd);
  }

  calcEA(address) {
    return address & 0xff;
  }
}
