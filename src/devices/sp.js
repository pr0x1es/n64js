import { Device } from './device.js';
import * as mi from './mi.js';
import * as logger from '../logger.js';
import { toString16, toString32 } from '../format.js';
import { hleProcessRSPTask } from '../hle.js';

const emulateRSP = true;

export const SP_MEM_ADDR_REG = 0x00;
export const SP_DRAM_ADDR_REG = 0x04;
export const SP_RD_LEN_REG = 0x08;
export const SP_WR_LEN_REG = 0x0C;
export const SP_STATUS_REG = 0x10;
export const SP_DMA_FULL_REG = 0x14;
export const SP_DMA_BUSY_REG = 0x18;
export const SP_SEMAPHORE_REG = 0x1C;

const memAddrWritableBits = 0xffff_fff8;
const dramAddrWritableBits = 0xffff_fff8;
const readLenWritableBits = 0xff8f_fff8;
const writeLenWritableBits = 0xff8f_fff8;

const memAddrBankBit = 0x1000;

const lenRegSkipMask = 0xfff0_0000;
const lenRegSkipShift = 20;
const lenRegCountMask = 0x000f_f000;
const lenRegCountShift = 12;
const lenRegLenMask = 0x0000_0fff;
const lenRegLenShift = 0;

export const SP_CLR_HALT = 0x0000001;
export const SP_SET_HALT = 0x0000002;
export const SP_CLR_BROKE = 0x0000004;
export const SP_CLR_INTR = 0x0000008;
export const SP_SET_INTR = 0x0000010;
export const SP_CLR_SSTEP = 0x0000020;
export const SP_SET_SSTEP = 0x0000040;
export const SP_CLR_INTR_BREAK = 0x0000080;
export const SP_SET_INTR_BREAK = 0x0000100;
export const SP_CLR_SIG0 = 0x0000200;
export const SP_SET_SIG0 = 0x0000400;
export const SP_CLR_SIG1 = 0x0000800;
export const SP_SET_SIG1 = 0x0001000;
export const SP_CLR_SIG2 = 0x0002000;
export const SP_SET_SIG2 = 0x0004000;
export const SP_CLR_SIG3 = 0x0008000;
export const SP_SET_SIG3 = 0x0010000;
export const SP_CLR_SIG4 = 0x0020000;
export const SP_SET_SIG4 = 0x0040000;
export const SP_CLR_SIG5 = 0x0080000;
export const SP_SET_SIG5 = 0x0100000;
export const SP_CLR_SIG6 = 0x0200000;
export const SP_SET_SIG6 = 0x0400000;
export const SP_CLR_SIG7 = 0x0800000;
export const SP_SET_SIG7 = 0x1000000;

export const SP_STATUS_HALT = 0x0001;
export const SP_STATUS_BROKE = 0x0002;
export const SP_STATUS_DMA_BUSY = 0x0004;
export const SP_STATUS_DMA_FULL = 0x0008;
export const SP_STATUS_IO_FULL = 0x0010;
export const SP_STATUS_SSTEP = 0x0020;
export const SP_STATUS_INTR_BREAK = 0x0040;
export const SP_STATUS_SIG0 = 0x0080;
export const SP_STATUS_SIG1 = 0x0100;
export const SP_STATUS_SIG2 = 0x0200;
export const SP_STATUS_SIG3 = 0x0400;
export const SP_STATUS_SIG4 = 0x0800;
export const SP_STATUS_SIG5 = 0x1000;
export const SP_STATUS_SIG6 = 0x2000;
export const SP_STATUS_SIG7 = 0x4000;

export const SP_STATUS_YIELD = SP_STATUS_SIG0;
export const SP_STATUS_YIELDED = SP_STATUS_SIG1;
export const SP_STATUS_TASKDONE = SP_STATUS_SIG2;

export const SPIBIST_PC_REG = 0x00;

const pcWritableBits = 0xffc;

export class SPMemDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("SPMem", hardware, hardware.sp_mem, rangeStart, rangeEnd);
  }

  calcEA(address) {
    // SPMem wraps around.
    return (address - this.rangeStart) % 0x2000;
  }

  write64(address, value) {
    // SD is broken - only the upper 32 bits are written.
    const ea = this.calcWriteEA(address);
    this.mem.set32(ea, Number(value >> 32n));
  }

  write16(address, value) {
    // SH is broken - it writes a 32-bit value.
    // It also uses 32 bits from the source register (i.e. value is not masked to 16 bits).
    const ea = this.calcWriteEA(address);
    const aligned = ea & ~3;
    const shift = 8 * (2 - (ea & 2));
    this.mem.set32(aligned, value << shift);
  }

  write8(address, value) {
    // SB is broken - it writes a 32-bit value.
    // It also uses 32 bits from the source register (i.e. value is not masked to 8 bits).
    const ea = this.calcWriteEA(address);
    const aligned = ea & ~3;
    const shift = 8 * (3 - (ea & 3));
    this.mem.set32(aligned, value << shift);
  }
}

export class SPIBISTDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("SPIBIST", hardware, hardware.sp_ibist_mem, rangeStart, rangeEnd);
  }

  write32(address, value) {
    const ea = this.calcWriteEA(address);
    switch (ea) {
      case SPIBIST_PC_REG:
        this.mem.set32(ea, value & pcWritableBits);
        break;

      default:
        logger.log(`Unhandled write to SPIBISTReg: ${toString32(value)} -> [${toString32(address)}]`);
    }

    // TODO: return random bits if read while the RSP is running.
  }
}

export class SPRegDevice extends Device {
  constructor(hardware, rangeStart, rangeEnd) {
    super("SPReg", hardware, hardware.sp_reg, rangeStart, rangeEnd);
  }

  write32(address, value) {
    this.writeReg32(this.calcWriteEA(address), value);
  }

  writeReg32(ea, value) {
    if (ea + 4 > this.u8.length) {
      throw 'Write is out of range';
    }
    switch (ea) {
      case SP_MEM_ADDR_REG:
        // TODO: register is latched and shouldn't return this value immediately.
        this.mem.set32(ea, value & memAddrWritableBits);
        break;
      case SP_DRAM_ADDR_REG:
        // TODO: register is latched and shouldn't return this value immediately.
        this.mem.set32(ea, value & dramAddrWritableBits);
        break;
      case SP_RD_LEN_REG:
        this.mem.set32(ea, value & readLenWritableBits);
        this.spCopyFromRDRAM();
        break;
      case SP_WR_LEN_REG:
        this.mem.set32(ea, value & writeLenWritableBits);
        this.spCopyToRDRAM();
        break;
      case SP_STATUS_REG:
        this.spUpdateStatus(value);
        break;
      case SP_DMA_FULL_REG:
      case SP_DMA_BUSY_REG:
        // Unwritable.
        break;
      case SP_SEMAPHORE_REG:
        // Writing any value causes next read to be 0.
        this.mem.set32(ea, 0);
        break;

      default:
        logger.log(`Unhandled write to SPReg: ${toString32(value)} -> [${toString32(address)}]`);
        this.mem.set32(ea, value);
    }
  }

  readU32(address) {
    this.logRead(address);
    return this.readRegU32(this.calcReadEA(address));
  }
  readS32(address) {
    this.logRead(address);
    return this.readRegU32(this.calcReadEA(address)) >> 0;
  }

  readRegU32(ea) {
    if (ea + 4 > this.u8.length) {
      throw 'Read is out of range';
    }
    const value = this.mem.getU32(ea);
    if (ea == SP_SEMAPHORE_REG) {
      // Reading causes next read to be 1.
      this.mem.set32(ea, 1);
    }
    return value;
  }

  halt() {
    const status = this.mem.setBits32(SP_STATUS_REG, SP_STATUS_TASKDONE | SP_STATUS_BROKE | SP_STATUS_HALT);
    if (status & SP_STATUS_INTR_BREAK) {
      this.hardware.miRegDevice.interruptSP();
    }
  }

  spUpdateStatus(flags) {
    if (!this.quiet) {
      if (flags & SP_CLR_HALT) { logger.log('SP: Clearing Halt'); }
      if (flags & SP_SET_HALT) { logger.log('SP: Setting Halt'); }
      if (flags & SP_CLR_BROKE) { logger.log('SP: Clearing Broke'); }
      // No SP_SET_BROKE
      if (flags & SP_CLR_INTR) { logger.log('SP: Clearing Interrupt'); }
      if (flags & SP_SET_INTR) { logger.log('SP: Setting Interrupt'); }
      if (flags & SP_CLR_SSTEP) { logger.log('SP: Clearing Single Step'); }
      if (flags & SP_SET_SSTEP) { logger.log('SP: Setting Single Step'); }
      if (flags & SP_CLR_INTR_BREAK) { logger.log('SP: Clearing Interrupt on break'); }
      if (flags & SP_SET_INTR_BREAK) { logger.log('SP: Setting Interrupt on break'); }
      if (flags & SP_CLR_SIG0) { logger.log('SP: Clearing Sig0 (Yield)'); }
      if (flags & SP_SET_SIG0) { logger.log('SP: Setting Sig0 (Yield)'); }
      if (flags & SP_CLR_SIG1) { logger.log('SP: Clearing Sig1 (Yielded)'); }
      if (flags & SP_SET_SIG1) { logger.log('SP: Setting Sig1 (Yielded)'); }
      if (flags & SP_CLR_SIG2) { logger.log('SP: Clearing Sig2 (TaskDone)'); }
      if (flags & SP_SET_SIG2) { logger.log('SP: Setting Sig2 (TaskDone)'); }
      if (flags & SP_CLR_SIG3) { logger.log('SP: Clearing Sig3'); }
      if (flags & SP_SET_SIG3) { logger.log('SP: Setting Sig3'); }
      if (flags & SP_CLR_SIG4) { logger.log('SP: Clearing Sig4'); }
      if (flags & SP_SET_SIG4) { logger.log('SP: Setting Sig4'); }
      if (flags & SP_CLR_SIG5) { logger.log('SP: Clearing Sig5'); }
      if (flags & SP_SET_SIG5) { logger.log('SP: Setting Sig5'); }
      if (flags & SP_CLR_SIG6) { logger.log('SP: Clearing Sig6'); }
      if (flags & SP_SET_SIG6) { logger.log('SP: Setting Sig6'); }
      if (flags & SP_CLR_SIG7) { logger.log('SP: Clearing Sig7'); }
      if (flags & SP_SET_SIG7) { logger.log('SP: Setting Sig7'); }
    }

    function setOrClear(statusBits, flags, clrMask, setMask, bit) {
      const set = flags & setMask;
      const clr = flags & clrMask;
      if (set && !clr) { 
        return statusBits | bit;
      } else if (clr && !set) {
        return statusBits & ~bit;
      }
      return statusBits;
    }

    let statusBits = this.mem.getU32(SP_STATUS_REG);

    let startRsp = false;
    let stopRsp = false;

    if ((flags & SP_SET_HALT) && (flags & SP_CLR_HALT)) { /* no-op */ }
    else if (flags & SP_SET_HALT) { statusBits |= SP_STATUS_HALT; stopRsp = true; }
    else if (flags & SP_CLR_HALT) { statusBits &= ~SP_STATUS_HALT; startRsp = true; }

    if ((flags & SP_SET_INTR) && (flags & SP_CLR_INTR)) { /* no-op */ }
    else if (flags & SP_SET_INTR) { this.hardware.mi_reg.setBits32(mi.MI_INTR_REG, mi.MI_INTR_SP); n64js.cpu0.updateCause3(); }   // Shouldn't ever set this?
    else if (flags & SP_CLR_INTR) { this.hardware.mi_reg.clearBits32(mi.MI_INTR_REG, mi.MI_INTR_SP); n64js.cpu0.updateCause3(); }

    statusBits = setOrClear(statusBits, flags, SP_CLR_BROKE, 0, SP_STATUS_BROKE);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SSTEP, SP_SET_SSTEP, SP_STATUS_SSTEP);
    statusBits = setOrClear(statusBits, flags, SP_CLR_INTR_BREAK, SP_SET_INTR_BREAK, SP_STATUS_INTR_BREAK);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG0, SP_SET_SIG0, SP_STATUS_SIG0);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG1, SP_SET_SIG1, SP_STATUS_SIG1);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG2, SP_SET_SIG2, SP_STATUS_SIG2);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG3, SP_SET_SIG3, SP_STATUS_SIG3);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG4, SP_SET_SIG4, SP_STATUS_SIG4);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG5, SP_SET_SIG5, SP_STATUS_SIG5);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG6, SP_SET_SIG6, SP_STATUS_SIG6);
    statusBits = setOrClear(statusBits, flags, SP_CLR_SIG7, SP_SET_SIG7, SP_STATUS_SIG7);
    this.mem.set32(SP_STATUS_REG, statusBits);

    if (startRsp) {
      if (!hleProcessRSPTask()) {
        if (emulateRSP) {
          n64js.rsp.startExecution();
        } else {
          n64js.hardware().spRegDevice.halt();
        }
      }
    } else if (stopRsp) {
      // As we handle all RSP via HLE, nothing to do here.
    }
  }

  spCopyFromRDRAM() {
    const spMemAddr = this.mem.getU32(SP_MEM_ADDR_REG) & 0x1fff;
    const rdRamAddr = this.mem.getU32(SP_DRAM_ADDR_REG) & 0x00ff_ffff;
    const lenReg = this.mem.getU32(SP_RD_LEN_REG);

    const len = (((lenReg & lenRegLenMask) >>> lenRegLenShift) | 7) + 1; // Add 1 then round to next multiple of 8.
    const count = ((lenReg & lenRegCountMask) >>> lenRegCountShift) + 1;
    const skip = ((lenReg & lenRegSkipMask) >>> lenRegSkipShift);

    // TODO: create DataViews for IMEM and DMEM to simplify wrapping?
    const bankBit = spMemAddr & memAddrBankBit; // DMAs wrap within imem or dmem.

    if (!this.quiet) {
      logger.log(`SP: copying ${len} bytes from ram ${toString32(rdRamAddr)} to sp ${toString16(spMemAddr)}, count ${count}, skip ${skip}`);
    }

    let memOffset = spMemAddr;
    let ramOffset = rdRamAddr;
    for (let c = 0; c < count; c++) {
      for (let i = 0; i < len; ++i) {
        this.hardware.sp_mem.u8[(bankBit | (memOffset) & 0xfff)] = this.hardware.ram.u8[ramOffset];
        memOffset++;
        ramOffset++;
      }
      ramOffset += skip;
    }

    // Update registers at the end of the transfer.
    // Address regs get set to the next memory address.
    // Len reg has count set to zero and len set to 0xff8 (-8, counting down). Skip is unchanged.
    this.mem.set32(SP_MEM_ADDR_REG, (bankBit | (memOffset) & 0xfff));
    this.mem.set32(SP_DRAM_ADDR_REG, ramOffset);
    this.mem.set32masked(SP_RD_LEN_REG, 0xff8 << lenRegLenShift, lenRegCountMask | lenRegLenMask);
    this.mem.set32masked(SP_WR_LEN_REG, 0xff8 << lenRegLenShift, lenRegCountMask | lenRegLenMask);

    this.mem.setBits32(SP_DMA_BUSY_REG, 0);
    this.mem.clearBits32(SP_STATUS_REG, SP_STATUS_DMA_BUSY);
  }

  spCopyToRDRAM() {
    const spMemAddr = this.mem.getU32(SP_MEM_ADDR_REG) & 0x1fff;
    const rdRamAddr = this.mem.getU32(SP_DRAM_ADDR_REG) & 0x00ff_ffff;
    const lenReg = this.mem.getU32(SP_WR_LEN_REG);

    const len = (((lenReg & lenRegLenMask) >>> lenRegLenShift) | 7) + 1; // Add 1 then round to next multiple of 8.
    const count = ((lenReg & lenRegCountMask) >>> lenRegCountShift) + 1;
    const skip = ((lenReg & lenRegSkipMask) >>> lenRegSkipShift);

    // TODO: create DataViews for IMEM and DMEM to simplify wrapping?
    const bankBit = spMemAddr & memAddrBankBit; // DMAs wrap within imem or dmem.

    if (!this.quiet) {
      logger.log(`SP: copying ${len} bytes from sp ${toString16(spMemAddr)} to ram ${toString32(rdRamAddr)}, count ${count}, skip ${skip}`);
    }

    let ramOffset = rdRamAddr;
    let memOffset = spMemAddr;
    for (let c = 0; c < count; c++) {
      for (let i = 0; i < len; ++i) {
        this.hardware.ram.u8[ramOffset] = this.hardware.sp_mem.u8[(bankBit | (memOffset) & 0xfff)];
        ramOffset++;
        memOffset++;
      }
      ramOffset += skip;
    }

    // Update registers at the end of the transfer.
    // Address regs get set to the next memory address.
    // Len reg has count set to zero and len set to 0xff8 (-8, counting down). Skip is unchanged.
    this.mem.set32(SP_MEM_ADDR_REG, (bankBit | (memOffset) & 0xfff));
    this.mem.set32(SP_DRAM_ADDR_REG, ramOffset);
    this.mem.set32masked(SP_RD_LEN_REG, 0xff8 << lenRegLenShift, lenRegCountMask | lenRegLenMask);
    this.mem.set32masked(SP_WR_LEN_REG, 0xff8 << lenRegLenShift, lenRegCountMask | lenRegLenMask);

    this.mem.setBits32(SP_DMA_BUSY_REG, 0);
    this.mem.clearBits32(SP_STATUS_REG, SP_STATUS_DMA_BUSY);
  }
}
