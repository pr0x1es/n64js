/*jshint jquery:true */

import * as format from './format.js';
import * as logger from './logger.js';
import { getFragmentMap, consumeFragmentInvalidationEvents } from './fragments.js';

window.n64js = window.n64js || {};

const kEnter = 13;
const kPageUp = 33;
const kPageDown = 34;
const kLeft = 37;
const kUp = 38;
const kRight = 39;
const kDown = 40;
const kF10 = 121;
const kF9 = 120;
const kF8 = 119;

class Debugger {
  constructor() {
    /** @type {?jQuery} */
    this.$debugContent = $('#debug-content');

    /** @type {?jQuery} */
    this.$status = $('#status');

    /** @type {?Array<?jQuery>} */
    this.$registers = [$('#cpu0-content'), $('#cpu1-content')];

    /** @type {?jQuery} */
    this.$disassembly = $('#disasm');

    /** @type {?jQuery} */
    this.$dynarecContent = $('#dynarec-content');

    /** @type {?jQuery} */
    this.$memoryContent = $('#memory-content');

    /** @type {number} The address to disassemble. */
    this.disasmAddress = 0;

    /** @type {number} The number of cycles executed the last time the display was updated. */
    this.lastCycles;

    /** @type {number} The program counter the last time the display was updated. */
    this.lastPC = -1;

    /** @type {!Array<!Object>} A list of recent memory accesses. */
    this.recentMemoryAccesses = [];

    /** @type {number} The address of the last memory access. */
    this.lastMemoryAccessAddress = 0;

    /**
     * When we execute a store instruction, keep track of some details so we can
     * show the value that was written.
     * @type {?Object} The address of the last memory access.
     */
    this.lastStore = null;

    /** @type {!Object<number, string>} A map of labels keyed by address. */
    this.labelMap = {};

    /** @type {number} How many cycles to execute before updating the debugger. */
    this.debugCycles = Math.pow(10, 0);

    logger.initialise($('.output'), () => {
      return format.toString32(n64js.cpu0.pc);
    });

    n64js.addResetCallback(this.onReset.bind(this));

    $('#output').find('#clear').click(function () {
      logger.clear();
    });

    const that = this;

    $('#cpu-controls').find('#speed').change(function () {
      that.debugCycles = Math.pow(10, $(this).val() | 0);
      logger.log('Speed is now ' + that.debugCycles);
    });

    $('#cpu').find('#address').change(function () {
      that.disasmAddress = parseInt($(this).val(), 16);
      that.updateDebug();
    });
    this.refreshLabelSelect();

    this.$memoryContent.find('input').change(function () {
      that.lastMemoryAccessAddress = parseInt($(this).val(), 16);
      that.updateMemoryView();
    });
    this.updateMemoryView();

    $('body').keydown(function (event) {
      let consumed = false;
      switch (event.which) {
        case kDown: consumed = true; that.disassemblerDown(); break;
        case kUp: consumed = true; that.disassemblerUp(); break;
        case kPageDown: consumed = true; that.disassemblerPageDown(); break;
        case kPageUp: consumed = true; that.disassemblerPageUp(); break;
        case kF8: consumed = true; n64js.toggleRun(); break;
        case kF9: consumed = true; n64js.toggleDebugDisplayList(); break;
        case kF10: consumed = true; n64js.step(); break;
        //default: alert( 'code:' + event.which);
      }
      if (consumed) {
        event.preventDefault();
      }
    });
  }

  updateMemoryView() {
    let addr = this.lastMemoryAccessAddress || 0x80000000;
    let $pre = this.$memoryContent.find('pre');
    $pre.empty().append(this.makeMemoryTable(addr, 1024));
  }

  refreshLabelSelect() {
    let $select = $('#cpu').find('#labels');

    let arr = [];
    for (let i in this.labelMap) {
      if (this.labelMap.hasOwnProperty(i)) {
        arr.push(i);
      }
    }
    arr.sort((a, b) => { return this.labelMap[a].localeCompare(this.labelMap[b]); });

    $select.html('');

    for (let i = 0; i < arr.length; ++i) {
      let address = arr[i];
      let label = this.labelMap[address];
      let $option = $('<option value="' + label + '">' + label + '</option>');
      $option.data('address', address);
      $select.append($option);
    }

    $select.change(function () {
      let contents = $select.find('option:selected').data('address');
      this.disasmAddress = /** @type {number} */(contents) >>> 0;
      this.updateDebug();
    });
  }

  onReset() {
    this.restoreLabelMap();
  }

  restoreLabelMap() {
    this.labelMap = n64js.getLocalStorageItem('debugLabels') || {};
    this.refreshLabelSelect();
    this.updateDebug();
  }

  storeLabelMap() {
    n64js.setLocalStorageItem('debugLabels', this.labelMap);
  }

  /**
   * Constructs HTML for a table of memory values.
   * @param {number} focusAddress The address to focus on.
   * @param {number} contextBytes The number of bytes of context.
   * @param {number=} bytesPerRow The number of bytes per row. Should be a power of two.
   * @param {Map<number,string>=} highlights Colours to highlight addresses with.
   * @return {!jQuery}
   */
  makeMemoryTable(focusAddress, contextBytes, bytesPerRow = 64, highlights = null) {
    let s = roundDown(focusAddress, bytesPerRow) - roundDown(contextBytes / 2, bytesPerRow);
    let e = s + contextBytes;

    let t = '';
    for (let a = s; a < e; a += bytesPerRow) {
      let r = format.toHex(a, 32) + ':';

      for (let o = 0; o < bytesPerRow; o += 4) {
        let curAddress = a + o >>> 0;
        let mem = n64js.hardware().memMap.readMemoryInternal32(curAddress);
        let style = '';
        if (highlights && highlights.has(curAddress)) {
          style = ' style="background-color: ' + highlights.get(curAddress) + '"';
        }
        r += ' <span id="mem-' + format.toHex(curAddress, 32) + '"' + style + '>' + format.toHex(mem, 32) + '</span>';
      }

      r += '\n';
      t += r;
    }

    return $('<span>' + t + '</span>');
  }

  // access is {reg,offset,mode}
  addRecentMemoryAccess(address, mode) {
    let col = (mode === 'store') ? '#faa' : '#ffa';
    if (mode === 'update') {
      col = '#afa';
    }

    let highlights = new Map();
    let alignedAddress = (address & ~3) >>> 0;
    highlights.set(alignedAddress, col);
    return this.makeMemoryTable(address, 32, 32, highlights);
  }

  makeLabelColor(address) {
    let i = address >>> 2;  // Lowest bits are always 0
    let hash = (i >>> 16) ^ ((i & 0xffff) * 2803);
    let r = (hash) & 0x1f;
    let g = (hash >>> 5) & 0x1f;
    let b = (hash >>> 10) & 0x1f;
    let h = (hash >>> 15) & 0x3;

    r *= 4;
    g *= 4;
    b *= 4;
    switch (h) {
      case 0: r *= 2; g *= 2; break;
      case 1: g *= 2; b *= 2; break;
      case 2: b *= 2; r *= 2; break;
      default: r *= 2; g *= 2; b *= 2; break;
    }

    return '#' + format.toHex(r, 8) + format.toHex(g, 8) + format.toHex(b, 8);
  }

  /**
   * Makes a table of co-processor 0 registers.
   * @param {!Map<string, string>} registerColours Register colour map.
   * @return {!jQuery}
   */
  makeCop0RegistersTable(registerColours) {
    let cpu0 = n64js.cpu0;
    let $table = $('<table class="register-table"><tbody></tbody></table>');
    let $body = $table.find('tbody');

    const kRegistersPerRow = 2;

    for (let i = 0; i < 32; i += kRegistersPerRow) {
      let $tr = $('<tr />');
      for (let r = 0; r < kRegistersPerRow; ++r) {
        let name = n64js.cop0gprNames[i + r];
        let $td = $('<td>' + name + '</td><td class="fixed">' + format.toString64(cpu0.gprHi[i + r], cpu0.gprLo[i + r]) + '</td>');

        if (registerColours.has(name)) {
          $td.attr('bgcolor', registerColours.get(name));
        }
        $tr.append($td);
      }
      $body.append($tr);
    }

    return $table;
  }

  /**
   * Makes a table of co-processor 1 registers.
   * @param {!Map<string, string>} registerColours Register colour map.
   * @return {!jQuery}
   */
  makeCop1RegistersTable(registerColours) {
    let $table = $('<table class="register-table"><tbody></tbody></table>');
    let $body = $table.find('tbody');
    let cpu1 = n64js.cpu1;

    for (let i = 0; i < 32; ++i) {
      let name = n64js.cop1RegisterNames[i];

      let $td;
      if ((i & 1) === 0) {
        $td = $('<td>' + name +
          '</td><td class="fixed fp-w">' + format.toString32(cpu1.uint32[i]) +
          '</td><td class="fixed fp-s">' + cpu1.float32[i] +
          '</td><td class="fixed fp-d">' + cpu1.float64[i / 2] +
          '</td>');
      } else {
        $td = $('<td>' + name +
          '</td><td class="fixed fp-w">' + format.toString32(cpu1.uint32[i]) +
          '</td><td class="fixed fp-s">' + cpu1.float32[i] +
          '</td><td>' +
          '</td>');
      }

      let $tr = $('<tr />');
      $tr.append($td);

      if (registerColours.has(name)) {
        $tr.attr('bgcolor', registerColours.get(name));
      } else if (registerColours.has(name + '-w')) {
        $tr.find('.fp-w').attr('bgcolor', registerColours.get(name + '-w'));
      } else if (registerColours.has(name + '-s')) {
        $tr.find('.fp-s').attr('bgcolor', registerColours.get(name + '-s'));
      } else if (registerColours.has(name + '-d')) {
        $tr.find('.fp-d').attr('bgcolor', registerColours.get(name + '-d'));
      }

      $body.append($tr);
    }

    return $table;
  }

  /**
   * Makes a table showing the status register contents.
   * @return {!jQuery}
   */
  makeStatusTable() {
    let cpu0 = n64js.cpu0;

    let $table = $('<table class="register-table"><tbody></tbody></table>');
    let $body = $table.find('tbody');

    $body.append('<tr><td>Ops</td><td class="fixed">' + cpu0.opsExecuted + '</td></tr>');
    $body.append('<tr><td>PC</td><td class="fixed">' + format.toString32(cpu0.pc) + '</td>' +
      '<td>delayPC</td><td class="fixed">' + format.toString32(cpu0.delayPC) + '</td></tr>');
    $body.append('<tr><td>EPC</td><td class="fixed">' + format.toString32(cpu0.control[cpu0.kControlEPC]) + '</td></tr>');
    $body.append('<tr><td>MultHi</td><td class="fixed">' + format.toString64(cpu0.multHi[1], cpu0.multHi[0]) + '</td>' +
      '<td>Cause</td><td class="fixed">' + format.toString32(cpu0.control[cpu0.kControlCause]) + '</td></tr>');
    $body.append('<tr><td>MultLo</td><td class="fixed">' + format.toString64(cpu0.multLo[1], cpu0.multLo[0]) + '</td>' +
      '<td>Count</td><td class="fixed">' + format.toString32(cpu0.control[cpu0.kControlCount]) + '</td></tr>');
    $body.append('<tr><td></td><td class="fixed"></td>' +
      '<td>Compare</td><td class="fixed">' + format.toString32(cpu0.control[cpu0.kControlCompare]) + '</td></tr>');

    for (let i = 0; i < cpu0.events.length; ++i) {
      $body.append('<tr><td>Event' + i + '</td><td class="fixed">' + cpu0.events[i].countdown + ', ' + cpu0.events[i].getName() + '</td></tr>');
    }

    $body.append(this.makeStatusRegisterRow());
    $body.append(this.makeMipsInterruptsRow());
    return $table;
  }

  makeStatusRegisterRow() {
    let $tr = $('<tr />');
    $tr.append('<td>SR</td>');

    const flagNames = ['IE', 'EXL', 'ERL'];//, '', '', 'UX', 'SX', 'KX' ];

    let sr = n64js.cpu0.control[n64js.cpu0.kControlSR];

    let $td = $('<td class="fixed" />');
    $td.append(format.toString32(sr));
    $td.append('&nbsp;');

    let i;
    for (i = flagNames.length - 1; i >= 0; --i) {
      if (flagNames[i]) {
        let isSet = (sr & (1 << i)) !== 0;

        let $b = $('<span>' + flagNames[i] + '</span>');
        if (isSet) {
          $b.css('font-weight', 'bold');
        }

        $td.append($b);
        $td.append('&nbsp;');
      }
    }

    $tr.append($td);
    return $tr;
  }

  makeMipsInterruptsRow() {
    const miIntrNames = ['SP', 'SI', 'AI', 'VI', 'PI', 'DP'];

    const miRegDevice = n64js.hardware().miRegDevice;
    const miIntrLive = miRegDevice.intrReg();
    const miIntrMask = miRegDevice.intrMaskReg();

    let $tr = $('<tr />');
    $tr.append('<td>MI Intr</td>');
    let $td = $('<td class="fixed" />');
    let i;
    for (i = 0; i < miIntrNames.length; ++i) {
      let isSet = (miIntrLive & (1 << i)) !== 0;
      let isEnabled = (miIntrMask & (1 << i)) !== 0;

      let $b = $('<span>' + miIntrNames[i] + '</span>');
      if (isSet) {
        $b.css('font-weight', 'bold');
      }
      if (isEnabled) {
        $b.css('background-color', '#AFF4BB');
      }

      $td.append($b);
      $td.append('&nbsp;');
    }
    $tr.append($td);
    return $tr;
  }

  setLabelText($elem, address) {
    if (this.labelMap.hasOwnProperty(address)) {
      $elem.append(' (' + this.labelMap[address] + ')');
    }
  }

  setLabelColor($elem, address) {
    $elem.css('color', this.makeLabelColor(address));
  }

  makeLabelText(address) {
    let t = '';
    if (this.labelMap.hasOwnProperty(address)) {
      t = this.labelMap[address];
    }
    while (t.length < 20) {
      t += ' ';
    }
    return t;
  }

  onLabelClicked(e) {
    let $label = $(e.delegateTarget);
    let address = /** @type {number} */($label.data('address')) >>> 0;
    let existing = this.labelMap[address] || '';
    let $input = $('<input class="input-mini" value="' + existing + '" />');

    const that = this;

    $input.keypress((event) => {
      if (event.which == 13) {
        let newVal = $input.val();
        if (newVal) {
          that.labelMap[address] = newVal.toString();
        } else {
          delete that.labelMap[address];
        }
        that.storeLabelMap();
        that.refreshLabelSelect();
        this.updateDebug();
      }
    });
    $input.blur(() => {
      $label.html(that.makeLabelText(address));
    });
    $label.empty().append($input);
    $input.focus();
  }

  onFragmentClicked(e) {
    let $elem = $(e.delegateTarget);
    let frag = $elem.data('fragment');
    logger.log('<pre>' + frag.func.toString() + '</pre>');
  }

  onClickBreakpoint(e) {
    let $elem = $(e.delegateTarget);
    let address = /** @type {number} */($elem.data('address')) >>> 0;
    n64js.toggleBreakpoint(address);
    this.updateDebug();
  }

  updateDebug() {
    // If the pc has changed since the last update, recenter the display (e.g. when we take a branch)
    if (n64js.cpu0.pc !== this.lastPC) {
      this.disasmAddress = n64js.cpu0.pc;
      this.lastPC = n64js.cpu0.pc;
    }

    // Figure out if we've just stepped by a single instruction. Ergh.
    let cpuCount = n64js.cpu0.getCount();
    let isSingleStep = this.lastCycles === (cpuCount - 1);
    this.lastCycles = cpuCount;

    let fragmentMap = getFragmentMap();
    let disassembly = n64js.disassemble(this.disasmAddress - 64, this.disasmAddress + 64);

    let $disGutter = $('<pre/>');
    let $disText = $('<pre/>');
    let currentInstruction;

    for (let i = 0; i < disassembly.length; ++i) {
      let a = disassembly[i];
      let address = a.instruction.address;
      let isTarget = a.isJumpTarget || this.labelMap.hasOwnProperty(address);
      let addressStr = (isTarget ? '<span class="dis-address-target">' : '<span class="dis-address">') + format.toHex(address, 32) + ':</span>';
      let label = '<span class="dis-label">' + this.makeLabelText(address) + '</span>';
      let t = addressStr + '  ' + format.toHex(a.instruction.opcode, 32) + '  ' + label + a.disassembly;

      let fragment = fragmentMap.get(address);
      if (fragment) {
        t += '<span class="dis-fragment-link"> frag - ops=' + fragment.opsCompiled + ' hit=' + fragment.executionCount + '</span>';
      }

      let $line = $('<span class="dis-line">' + t + '</span>');
      $line.find('.dis-label')
        .data('address', address)
        .css('color', this.makeLabelColor(address))
        .click(this.onLabelClicked.bind(this));

      if (fragment) {
        $line.find('.dis-fragment-link')
          .data('fragment', fragment)
          .click(this.onFragmentClicked.bind(this));
      }

      // Keep track of the current instruction (for register formatting) and highlight.
      if (address === n64js.cpu0.pc) {
        currentInstruction = a.instruction;
        $line.addClass('dis-line-cur');
      }
      if (isTarget) {
        $line.addClass('dis-line-target');

        this.setLabelColor($line.find('.dis-address-target'), address);
      }

      $disText.append($line);
      $disText.append('<br>');

      let bpText = '&nbsp;';
      if (n64js.isBreakpoint(address)) {
        bpText = '&bull;';
      }
      let $bp = $('<span>' + bpText + '</span>').data('address', address).click(this.onClickBreakpoint.bind(this));

      $disGutter.append($bp);
      $disGutter.append('<br>');
    }

    // Links for branches, jumps etc should jump to the target address.
    $disText.find('.dis-address-jump').each(function () {
      let address = parseInt($(this).text(), 16);

      this.setLabelText($(this), address);
      this.setLabelColor($(this), address);

      $(this).click(function () {
        this.disasmAddress = address;
        this.refreshDebugger();
      });
    }.bind(this));

    let registerColours = this.makeRegisterColours(currentInstruction);
    for (let [reg, colour] of registerColours) {
      $disText.find('.dis-reg-' + reg).css('background-color', colour);
    }

    this.$disassembly.find('.dis-recent-memory').html(this.makeRecentMemoryAccesses(isSingleStep, currentInstruction));

    this.$disassembly.find('.dis-gutter').empty().append($disGutter);
    this.$disassembly.find('.dis-view').empty().append($disText);

    this.$status.empty().append(this.makeStatusTable());

    this.$registers[0].empty().append(this.makeCop0RegistersTable(registerColours));
    this.$registers[1].empty().append(this.makeCop1RegistersTable(registerColours));
  }

  /**
   * Makes a map of colours keyed by register name.
   * @param {?Object} instruction The instruction to produce colours for.
   * @return {!Map<string, string>}
   */
  makeRegisterColours(instruction) {
    const availColours = [
      '#F4EEAF', // yellow
      '#AFF4BB', // green
      '#F4AFBE'  // blue
    ];

    let registerColours = new Map();
    if (instruction) {
      let nextColIdx = 0;
      for (let i in instruction.srcRegs) {
        if (!registerColours.hasOwnProperty(i)) {
          registerColours.set(i, availColours[nextColIdx++]);
        }
      }
      for (let i in instruction.dstRegs) {
        if (!registerColours.hasOwnProperty(i)) {
          registerColours.set(i, availColours[nextColIdx++]);
        }
      }
    }
    return registerColours;
  }

  makeRecentMemoryAccesses(isSingleStep, currentInstruction) {
    // Keep a small queue showing recent memory accesses
    if (isSingleStep) {
      // Check if we've just stepped over a previous write op, and update the result
      if (this.lastStore) {
        if ((this.lastStore.cycle + 1) === n64js.cpu0.opsExecuted) {
          let updatedElement = this.addRecentMemoryAccess(this.lastStore.address, 'update');
          this.lastStore.element.append(updatedElement);
        }
        this.lastStore = null;
      }

      if (currentInstruction.memory) {
        let access = currentInstruction.memory;
        let newAddress = n64js.cpu0.gprLo[access.reg] + access.offset;
        let element = this.addRecentMemoryAccess(newAddress, access.mode);

        if (access.mode === 'store') {
          this.lastStore = {
            address: newAddress,
            cycle: n64js.cpu0.opsExecuted,
            element: element,
          };
        }

        this.recentMemoryAccesses.push({ element: element });

        // Nuke anything that happened more than N cycles ago
        //while (this.recentMemoryAccesses.length > 0 && this.recentMemoryAccesses[0].cycle+10 < cycle)
        if (this.recentMemoryAccesses.length > 4) {
          this.recentMemoryAccesses.splice(0, 1);
        }

        this.lastMemoryAccessAddress = newAddress;
      }
    } else {
      // Clear the recent memory accesses when running.
      this.recentMemoryAccesses = [];
      this.lastStore = null;
    }

    let $recent = $('<pre />');
    if (this.recentMemoryAccesses.length > 0) {
      const fadingColours = ['#bbb', '#999', '#666', '#333'];
      for (let i = 0; i < this.recentMemoryAccesses.length; ++i) {
        let element = this.recentMemoryAccesses[i].element;
        element.css('color', fadingColours[i]);
        $recent.append(element);
      }
    }

    return $recent;
  }

  updateDynarec() {
    let invals = consumeFragmentInvalidationEvents();
    let histogram = new Map();
    let maxBucket = 0;
  
    // Build a flattened list of all fragments
    let fragmentsList = [];
    for (let [pc, fragment] of getFragmentMap()) {
      let i = fragment.executionCount > 0 ? Math.floor(Math.log10(fragment.executionCount)) : 0;
      histogram.set(i, (histogram.get(i) || 0) + 1);
      fragmentsList.push(fragment);
      maxBucket = Math.max(maxBucket, i);
    }
  
    fragmentsList.sort((a, b) => {
      return b.opsCompiled * b.executionCount - a.opsCompiled * a.executionCount;
    });
  
    let $t = $('<div class="container-fluid" />');
  
    // Histogram showing execution counts
    let t = '';
    t += '<div class="row">';
    t += '<table class="table table-condensed table-nonfluid"><tr><th>Execution Count</th><th>Frequency</th></tr>';
    for (let i = 0; i <= maxBucket; i++) {
      let count = histogram.get(i) || 0;
      let range = '< ' + Math.pow(10, i + 1);
      t += '<tr><td>' + range + '</td><td>' + count + '</td></tr>';
    }
    t += '</table>';
    t += '</div>';
    $t.append(t);
  
    // Table of hot fragments, and the corresponding js
    t = '';
    t += '<div class="row">';
    t += '  <div class="col-lg-6" id="fragments" />';
    t += '  <div class="col-lg-6" id="fragment-code" />';
    t += '</div>';
    let $fragmentDiv = $(t);
  
    createHotFragmentsTable($fragmentDiv, fragmentsList);
  
    $t.append($fragmentDiv);
  
    // Evictions
    if (invals.length > 0) {
      t = '';
      t += '<div class="row">';
      t += '<div class="col-lg-6">';
      t += '<table class="table table-condensed">';
      t += '<tr><th>Address</th><th>Length</th><th>System</th><th>Fragments Removed</th></tr>';
      for (let i = 0; i < invals.length; ++i) {
        let vals = [
          format.toString32(invals[i].address),
          invals[i].length,
          invals[i].system,
          invals[i].fragmentsRemoved,
        ];
        t += '<tr><td>' + vals.join('</td><td>') + '</td></tr>';
      }
      t += '</table>';
      t += '</div>';
      t += '</div>';
      $t.append(t);
    }
  
    this.$dynarecContent.empty().append($t);
  }

  createHotFragmentsTable($fragmentDiv, fragmentsList) {
    let $code = $fragmentDiv.find('#fragment-code');
    let $table = $('<table class="table table-condensed" />');
    let columns = ['Address', 'Execution Count', 'Length', 'ExecCount * Length'];
  
    $table.append('<tr><th>' + columns.join('</th><th>') + '</th></tr>');
    for (let i = 0; i < fragmentsList.length && i < 20; ++i) {
      let fragment = fragmentsList[i];
      let vals = [
        format.toString32(fragment.entryPC),
        fragment.executionCount,
        fragment.opsCompiled,
        fragment.executionCount * fragment.opsCompiled
      ];
      let $tr = $('<tr><td>' + vals.join('</td><td>') + '</td></tr>');
      initFragmentRow($tr, fragment, $code);
      $table.append($tr);
    }
    $fragmentDiv.find('#fragments').append($table);
  
    if (fragmentsList.length > 0) {
      $code.append('<pre>' + fragmentsList[0].func.toString() + '</pre>');
    }
  }
  
  initFragmentRow($tr, fragment, $code) {
    $tr.click(() => {
      $code.html('<pre>' + fragment.func.toString() + '</pre>');
    });
  }
  
  disassemblerDown() {
    this.disasmAddress += 4;
    this.refreshDebugger();
  }
  
  disassemblerUp() {
    this.disasmAddress -= 4;
    this.refreshDebugger();
  }
  
  disassemblerPageDown() {
    this.disasmAddress += 64;
    this.refreshDebugger();
  }
  
  disassemblerPageUp() {
    this.disasmAddress -= 64;
    this.refreshDebugger();
  }

  refreshDebugger() {
    if (this.$dynarecContent.hasClass('active')) {
      this.updateDynarec();
    }
  
    if (this.$debugContent.hasClass('active')) {
      this.updateDebug();
    }
  
    if (this.$memoryContent.hasClass('active')) {
      this.updateMemoryView();
    }
  };
  
}

// FIXME: Move initialisation of this to n64.js when everything is encapsulated.
// FIXME: can't use debugger as a variable name - fix this when wrapping in a class.
export let dbg = null;

n64js.getDebugCycles = () => {
  return dbg.debugCycles;
};

n64js.toggleDebugger = () => {
  // This toggles both the display list debugger (#adjacent-debug) and the main debugger (no id).
  // TODO: explicitly toggle panels.
  $('.debug').toggle();
};

n64js.debuggerVisible = () => {
  return $('.debug').is(':visible');
};

n64js.hideDebugger = () => {
  $('.debug').hide();
}

n64js.initialiseDebugger = function () {
  dbg = new Debugger();
};

function roundDown(x, a) {
  return x & ~(a - 1);
}

n64js.refreshDebugger = function () {
  dbg.refreshDebugger()
};
