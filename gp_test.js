// Game plan scheduling tests
// Run with: npm test     (or: node gp_test.js)
//
// These tests run against the REAL functions in src/main.js — they are
// extracted at runtime, not pasted in. If main.js changes, these tests see it.
// Do NOT paste copies of main.js functions into this file: a copy can pass
// while the shipped code is broken, which is exactly how a corrupted regex
// escape in gpNormalizeTime2 survived undetected.

var fs = require('fs')
var path = require('path')

// ── LOCATE main.js ──
// Works from the repo root (src/main.js) or a flat working dir (main.js).
var CANDIDATES = ['src/main.js', 'main.js', '../src/main.js', '../main.js']
var mainPath = null
for (var i = 0; i < CANDIDATES.length; i++) {
  var p = path.resolve(__dirname, CANDIDATES[i])
  if (fs.existsSync(p)) { mainPath = p; break }
}
if (!mainPath) {
  console.error('Could not find main.js. Looked for: ' + CANDIDATES.join(', '))
  console.error('Run from the repo root, or restore main.js with:')
  console.error('  curl -s "https://raw.githubusercontent.com/hellokevintaylor-ui/nourish-app/main/src/main.js" > src/main.js')
  process.exit(1)
}
var MAIN_SRC = fs.readFileSync(mainPath, 'utf8')

// ── EXTRACT FUNCTIONS BY BRACE MATCHING ──
function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('Function not found in main.js: ' + name)
  var depth = 0, started = false
  for (var j = start; j < src.length; j++) {
    var c = src[j]
    if (c === '{') { depth++; started = true }
    else if (c === '}') {
      depth--
      if (started && depth === 0) return src.slice(start, j + 1)
    }
  }
  throw new Error('Unbalanced braces while extracting: ' + name)
}

var FN_NAMES = [
  'gpParseTime', 'gpFormatTime', 'gpNormalizeTime2',
  'gpNormalizeStep', 'gpParseWindows', 'gpParseConstraints', 'gpBuildTimeline'
]
var sources = {}
FN_NAMES.forEach(function(n) { sources[n] = extractFn(MAIN_SRC, n) })

// ── BUILD SANDBOX ──
// `state` is stubbed (gpBuildTimeline reads state.gamePlanModal.date on the
// fallback path). `console` is silenced so the functions' own debug logging
// does not drown the test output.
var quietConsole = { log: function() {}, warn: function() {}, error: function() {} }
var stateStub = { gamePlanModal: { date: null } }

var body = FN_NAMES.map(function(n) { return sources[n] }).join('\n\n') +
           '\nreturn { ' + FN_NAMES.join(', ') + ' };'
var gp = new Function('state', 'console', body)(stateStub, quietConsole)

var gpParseTime = gp.gpParseTime
var gpFormatTime = gp.gpFormatTime
var gpNormalizeTime2 = gp.gpNormalizeTime2
var gpParseConstraints = gp.gpParseConstraints
var gpBuildTimeline = gp.gpBuildTimeline

// ── TEST RUNNER ──
var passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); failed++ }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

function windowsFor(notes, targetTime) {
  return gpParseConstraints(notes, gpParseTime(targetTime)).windows || []
}
function assertWindow(windows, idx, label, startStr, endStr) {
  var w = windows[idx]
  assert(w, 'window[' + idx + '] missing (got ' +
    windows.map(function(x) { return x.label }).join(',') + ')')
  assert(w.label === label, 'window[' + idx + '].label: expected ' + label + ' got ' + w.label)
  if (startStr) {
    var es = gpParseTime(startStr)
    assert(Math.abs(w.startMins - es) < 5,
      'window[' + idx + '].start: expected ' + startStr + ' got ' + gpFormatTime(w.startMins))
  }
  if (endStr) {
    var ee = gpParseTime(endStr)
    assert(Math.abs(w.endMins - ee) < 5,
      'window[' + idx + '].end: expected ' + endStr + ' got ' + gpFormatTime(w.endMins))
  }
}
// gpBuildTimeline returns [{time, step}]; the last entry is the "is served" line.
function lastCookStep(timeline) { return timeline[timeline.length - 2] }

console.log('Testing against: ' + path.relative(process.cwd(), mainPath) + '\n')

// ════════════════════════════════════════════
// SOURCE INTEGRITY
// ════════════════════════════════════════════
test('Integrity: no control characters in gp* source', function() {
  // A literal 0x08 once replaced the \b word-boundary anchor in
  // gpNormalizeTime2, silently killing its am/pm normalization.
  var BAD = { 0x08: 'BACKSPACE', 0x0b: 'VTAB', 0x0c: 'FORMFEED', 0x00: 'NUL', 0x07: 'BELL' }
  FN_NAMES.forEach(function(n) {
    var src = sources[n]
    for (var i = 0; i < src.length; i++) {
      var code = src.charCodeAt(i)
      assert(!BAD[code], n + ' contains a literal ' + BAD[code] +
        ' (0x' + code.toString(16) + ') at offset ' + i + ' — likely a corrupted escape')
    }
  })
})

test('Integrity: gpNormalizeTime2 normalizes bare a/p suffixes', function() {
  var cases = [['5:30p', '5:30 PM'], ['8a', '8:00 AM'], ['12p', '12:00 PM'],
               ['12a', '12:00 AM'], ['1:15p', '1:15 PM'], ['11a', '11:00 AM']]
  cases.forEach(function(c) {
    var got = gpFormatTime(gpNormalizeTime2(c[0]))
    assert(got === c[1], c[0] + ' -> expected ' + c[1] + ' got ' + got)
  })
})

// ════════════════════════════════════════════
// SCENARIO 1: Simple - start at 5:30p, eat at 7p
// ════════════════════════════════════════════
test('Scenario 1: Simple start time', function() {
  var notes = 'User constraint: i can start cooking at 5:30p\nUser constraint: eat at 7pm'
  var windows = windowsFor(notes, '7:00 PM')
  assert(windows.length > 0, 'should have at least 1 window')
  assertWindow(windows, 0, 'cooking', '5:30 PM', '7:00 PM')

  var steps = [
    { step: 'Season chicken', active_min: 5, passive_min: 0, window: 'cooking' },
    { step: 'Roast chicken', active_min: 5, passive_min: 40, window: 'cooking' },
    { step: 'Rest chicken', active_min: 0, passive_min: 10, window: 'cooking' },
    { step: 'Plate and serve', active_min: 5, passive_min: 0, window: 'cooking' }
  ]
  var timeline = gpBuildTimeline(steps, '7:00 PM', false, 'Dinner', notes, windows)
  var last = lastCookStep(timeline)
  assert(gpParseTime(last.time) + 5 <= gpParseTime('7:00 PM'),
    'last step should finish by 7PM, got ' + last.time)
  assert(gpParseTime(timeline[0].time) >= gpParseTime('5:30 PM'),
    'first step should be at or after 5:30PM, got ' + timeline[0].time)
})

// ════════════════════════════════════════════
// SCENARIO 2: Prep window + gap + cooking
// ════════════════════════════════════════════
test('Scenario 2: Prep 1-2pm, resume 5:30p, eat 6:30p', function() {
  var notes = 'User constraint: prep between 1p and 2p, then resume cooking at 5:30p'
  var windows = windowsFor(notes, '6:30 PM')
  assert(windows.length >= 2, 'should have prep + cooking windows, got ' + windows.length)
  assertWindow(windows, 0, 'prep', '1:00 PM', '2:00 PM')
  assertWindow(windows, windows.length - 1, 'cooking', '5:30 PM', '6:30 PM')

  var steps = [
    { step: 'Toast pine nuts', active_min: 5, passive_min: 0, window: 'prep' },
    { step: 'Make vinaigrette', active_min: 8, passive_min: 0, window: 'prep' },
    { step: 'Roast potatoes', active_min: 5, passive_min: 45, window: 'cooking' },
    { step: 'Plate', active_min: 5, passive_min: 0, window: 'cooking' }
  ]
  var timeline = gpBuildTimeline(steps, '6:30 PM', false, 'Dinner', notes, windows)
  var prep = timeline.filter(function(s) { return /pine nuts|vinaigrette/.test(s.step) })
  var cook = timeline.filter(function(s) { return /potatoes|Plate/.test(s.step) })
  assert(prep.length === 2, 'both prep steps placed, got ' + prep.length)
  prep.forEach(function(s) {
    var t = gpParseTime(s.time)
    assert(t >= gpParseTime('1:00 PM') && t < gpParseTime('2:00 PM'),
      'prep step "' + s.step + '" should sit in 1-2PM, got ' + s.time)
  })
  assert(gpParseTime(cook[0].time) >= gpParseTime('5:30 PM'),
    'cooking starts at 5:30PM+, got ' + cook[0].time)
})

// ════════════════════════════════════════════
// SCENARIO 3: Three explicit windows
// ════════════════════════════════════════════
test('Scenario 3: 8a-9a, 1p-2p, cooking 5p-7:30p', function() {
  var notes = 'User constraint: window from 8a to 9a, then another window from 1p to 2p, then cooking from 5p to 7:30p'
  var windows = windowsFor(notes, '7:30 PM')
  assert(windows.length === 3, 'should have 3 windows, got ' + windows.length +
    ': ' + windows.map(function(w) { return w.label }).join(','))
  assertWindow(windows, 0, 'morning_prep', '8:00 AM', '9:00 AM')
  assertWindow(windows, 1, 'afternoon_prep', '1:00 PM', '2:00 PM')
  assertWindow(windows, 2, 'cooking', '5:00 PM', '7:30 PM')
})

// ════════════════════════════════════════════
// SCENARIO 4: Night before + morning + cooking
// ════════════════════════════════════════════
test('Scenario 4: Night before, morning, cook at 6p, eat at 8p', function() {
  var notes = 'User constraint: night before i have an hour. morning, some more things. start cooking at 6p for dinner at 8p'
  var windows = windowsFor(notes, '8:00 PM')
  var labels = windows.map(function(w) { return w.label })
  assert(labels.indexOf('night_before') >= 0, 'should have night_before, got ' + labels.join(','))
  assert(labels.indexOf('morning_prep') >= 0, 'should have morning_prep, got ' + labels.join(','))
  assert(labels.indexOf('cooking') >= 0, 'should have cooking, got ' + labels.join(','))
  var cookWin = windows.find(function(w) { return w.label === 'cooking' })
  assert(Math.abs(cookWin.startMins - gpParseTime('6:00 PM')) < 5,
    'cooking starts at 6PM, got ' + gpFormatTime(cookWin.startMins))
})

// ════════════════════════════════════════════
// SCENARIO 5: Tonight + 10a-12p + resume 5:30p
// ════════════════════════════════════════════
test('Scenario 5: Tonight + 10a-12p window + resume 5:30p, eat 7p', function() {
  var notes = 'User constraint: i can do some prep tonight. then i have a window between 10a and 12p to do more prep. i can resume the final cooking push at 5:30p for dinner at 7p'
  var windows = windowsFor(notes, '7:00 PM')
  var labels = windows.map(function(w) { return w.label })
  assert(labels.indexOf('night_before') >= 0, 'should have night_before, got ' + labels.join(','))
  assert(labels.indexOf('morning_prep') >= 0, 'should have morning_prep 10a-12p, got ' + labels.join(','))
  assert(labels.indexOf('cooking') >= 0, 'should have cooking, got ' + labels.join(','))
  var cookWin = windows.find(function(w) { return w.label === 'cooking' })
  assert(Math.abs(cookWin.startMins - gpParseTime('5:30 PM')) < 5,
    'cooking starts at 5:30PM, got ' + gpFormatTime(cookWin.startMins))
})

// ════════════════════════════════════════════
// SCENARIO 6: Backwards anchor - food hot at dinner
// ════════════════════════════════════════════
test('Scenario 6: Cooking steps land hot at dinner time', function() {
  var windows = [{ label: 'cooking', startMins: gpParseTime('5:30 PM'), endMins: gpParseTime('7:00 PM') }]
  var steps = [
    { step: 'Preheat oven', active_min: 2, passive_min: 0, window: 'cooking' },
    { step: 'Season chicken', active_min: 5, passive_min: 0, window: 'cooking' },
    { step: 'Roast chicken', active_min: 3, passive_min: 45, window: 'cooking' },
    { step: 'Rest chicken 10 min', active_min: 0, passive_min: 10, window: 'cooking' },
    { step: 'Plate and serve', active_min: 5, passive_min: 0, window: 'cooking' }
  ]
  var timeline = gpBuildTimeline(steps, '7:00 PM', false, 'Dinner', '', windows)
  var lastEnd = gpParseTime(lastCookStep(timeline).time) + 5
  assert(Math.abs(lastEnd - gpParseTime('7:00 PM')) <= 5,
    'last cooking step should finish at ~7PM, got ' + gpFormatTime(lastEnd))
  assert(gpParseTime(timeline[0].time) >= gpParseTime('5:30 PM'),
    'first step at or after 5:30PM, got ' + timeline[0].time)
})

// ════════════════════════════════════════════
// SCENARIO 7: No false positives - "4-5 minutes" isn't a window
// ════════════════════════════════════════════
test('Scenario 7: Duration ranges not mistaken for time windows', function() {
  var notes = 'User constraint: start at 5pm. simmer for 4-5 minutes. roast for 10 to 15 minutes.'
  var windows = windowsFor(notes, '7:00 PM')
  windows.forEach(function(w) {
    assert(w.startMins >= gpParseTime('4:00 PM') || w.startMins <= 0,
      'window ' + w.label + ' start=' + w.startMins + ' looks like a duration, not a time')
  })
})

// ════════════════════════════════════════════
// SCENARIO 8: Label-only windows render as headers
// ════════════════════════════════════════════
test('Scenario 8: night_before renders as a label, not a clock time', function() {
  // night_before uses startMins -60. It must surface as a section header;
  // if it ever leaked into gpFormatTime it would render as "11:00 PM".
  var windows = [
    { label: 'night_before', startMins: -60, endMins: 0 },
    { label: 'cooking', startMins: gpParseTime('5:30 PM'), endMins: gpParseTime('7:00 PM') }
  ]
  var steps = [
    { step: 'Marinate the pork', active_min: 10, passive_min: 0, window: 'night_before' },
    { step: 'Sear and roast', active_min: 10, passive_min: 30, window: 'cooking' },
    { step: 'Plate and serve', active_min: 5, passive_min: 0, window: 'cooking' }
  ]
  var timeline = gpBuildTimeline(steps, '7:00 PM', false, 'Dinner', '', windows)
  var nb = timeline.find(function(s) { return /Marinate/.test(s.step) })
  assert(nb, 'night_before step should be in the timeline')
  assert(nb.time === 'Night Before',
    'night_before step should read "Night Before", got "' + nb.time + '"')
  assert(!/\d/.test(nb.time), 'night_before label should not contain a clock time')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
