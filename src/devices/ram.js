import { Device } from './device.js';
import { toString32 } from '../format.js';
import * as logger from '../logger.js';

export class MappedMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("VMEM", hardware, null, rangeStart, rangeEnd);
    this.ram = hardware.ram;
  }

  readInternal32(address) {
    const mapped = n64js.cpu0.translateReadInternal(address) & 0x007fffff;
    if (mapped !== 0) {
      if (mapped + 4 <= this.ram.u8.length) {
        return this.ram.readU32(mapped);
      }
    }
    return 0x00000000;
  }

  writeInternal32(address, value) {
    const mapped = n64js.cpu0.translateReadInternal(address) & 0x007fffff;
    if (mapped !== 0) {
      if (mapped + 4 <= this.ram.u8.length) {
        this.ram.write32(mapped, value);
      }
    }
  }

  readU32(address) {
    const mapped = n64js.cpu0.translateRead(address) & 0x007fffff;
    if (mapped !== 0) {
      return this.ram.readU32(mapped);
    }
    n64js.halt('virtual readU32 failed - need to throw refill/invalid');
    return 0x00000000;
  }

  readU16(address) {
    const mapped = n64js.cpu0.translateRead(address) & 0x007fffff;
    if (mapped !== 0) {
      return this.ram.readU16(mapped);
    }
    n64js.halt('virtual readU16 failed - need to throw refill/invalid');
    return 0x0000;
  }

  readU8(address) {
    const mapped = n64js.cpu0.translateRead(address) & 0x007fffff;
    if (mapped !== 0) {
      return this.ram.readU8(mapped);
    }
    n64js.halt('virtual readU8 failed - need to throw refill/invalid');
    return 0x00;
  }

  readS32(address) {
    const mapped = n64js.cpu0.translateRead(address) & 0x007fffff;
    if (mapped !== 0) {
      return this.ram.readS32(mapped);
    }
    n64js.halt('virtual readS32 failed - need to throw refill/invalid');
    return 0;
  }

  readS16(address) {
    const mapped = n64js.cpu0.translateRead(address) & 0x007fffff;
    if (mapped !== 0) {
      return this.ram.readS16(mapped);
    }
    n64js.halt('virtual readS16 failed - need to throw refill/invalid');
    return 0x0000;
  }

  readS8(address) {
    const mapped = n64js.cpu0.translateRead(address);
    if (mapped !== 0) {
      return this.ram.readS8(mapped);
    }
    n64js.halt('virtual readS8 failed - need to throw refill/invalid');
    return 0x00;
  }

  write64masked(address, value, mask) {
    // Align address to 64 bits after translation.
    const mapped = n64js.cpu0.translateWrite(address) & 0x007ffff8;
    if (mapped === 0) {
      n64js.halt('virtual write32masked failed - need to throw refill/invalid');
      return;
    }
    this.ram.write64masked(mapped, value, mask);
  }

  write32masked(address, value, mask) {
    // Align address to 32 bits after translation.
    const mapped = n64js.cpu0.translateWrite(address) & 0x007ffffc;
    if (mapped === 0) {
      n64js.halt('virtual write32masked failed - need to throw refill/invalid');
      return;
    }
    this.ram.write32masked(mapped, value, mask);
  }

  write32(address, value) {
    const mapped = n64js.cpu0.translateWrite(address) & 0x007fffff;
    if (mapped !== 0) {
      this.ram.write32(mapped, value);
      return;
    }
    n64js.halt('virtual write32 failed - need to throw refill/invalid');
  }

  write16(address, value) {
    const mapped = n64js.cpu0.translateWrite(address) & 0x007fffff;
    if (mapped !== 0) {
      this.ram.write16(mapped, value);
      return;
    }
    n64js.halt('virtual write16 failed - need to throw refill/invalid');
  }

  write8(address, value) {
    const mapped = n64js.cpu0.translateWrite(address) & 0x007fffff;
    if (mapped !== 0) {
      this.ram.write8(mapped, value);
      return;
    }
    n64js.halt('virtual write8 failed - need to throw refill/invalid');
  }
}


export class CachedMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("RAM", hardware, hardware.ram, rangeStart, rangeEnd);

    // Used by n64js.getRamS32Array.
    this.dataView = this.mem.dataView;
    this.s32 = new Int32Array(this.mem.arrayBuffer);
  }

  // This function gets hit A LOT, so eliminate as much fat as possible.
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
