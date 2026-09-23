// Weight chart / period math tests
// Run with: npm test     (or: node wc_test.js)
//
// Like gp_test.js, these run against the REAL wc* functions in src/main.js,
// extracted at runtime. Do NOT paste copies of main.js functions in here.
//
// Timezone is pinned to New York so the daylight-saving cases (Nov 1 2026,
// Mar 14 2027) actually exercise a DST transition. Must be set before any Date.
process.env.TZ = 'America/New_York'

var fs = require('fs')
var path = require('path')

var CANDIDATES = ['src/main.js', 'main.js', '../src/main.js', '../main.js']
var mainPath = null
for (var i = 0; i < CANDIDATES.length; i++) {
  var p = path.resolve(__dirname, CANDIDATES[i])
  if (fs.existsSync(p)) { mainPath = p; break }
}
if (!mainPath) { console.error('Could not find main.js. Looked for: ' + CANDIDATES.join(', ')); process.exit(1) }
var MAIN_SRC = fs.readFileSync(mainPath, 'utf8')

function extractFn(src, name) {
  var start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('Function not found in main.js: ' + name)
  var depth = 0, started = false
  for (var j = start; j < src.length; j++) {
    var c = src[j]
    if (c === '{') { depth++; started = true }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(start, j + 1) }
  }
  throw new Error('Unbalanced braces while extracting: ' + name)
}

var FN_NAMES = [
  'wcLocalDateStr', 'wcAddDays', 'wcDayDiff', 'wcMondayOf', 'wcMonthStart', 'wcFmt', 'wcRangeLabel',
  'wcPeriodBounds', 'wcPhaseRate', 'wcPhaseDirection', 'wcPlanWeightAtDay', 'wcPhaseHitDay',
  'wcPhaseForDate', 'wcPlanAtDate', 'wcPlanSegments', 'wcBucketWeights', 'wcPeriodChange', 'wcChunks'
]
var body = FN_NAMES.map(function(n) { return extractFn(MAIN_SRC, n) }).join('\n\n') +
  '\nreturn { ' + FN_NAMES.join(', ') + ' };'
var wc = new Function(body)()

var passed = 0, failed = 0
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); passed++ }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); failed++ }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg ? msg + ': ' : '') + 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}
function near(actual, expected, msg) {
  if (Math.abs(actual - expected) > 1e-6) throw new Error((msg ? msg + ': ' : '') + 'expected ~' + expected + ', got ' + actual)
}
function bounds(win, offset, today, all) { return wc.wcPeriodBounds(win, offset, today, all) }

// ── Date arithmetic ──
test('Date math survives the Nov 1 2026 DST fall-back', function() {
  eq(wc.wcAddDays('2026-10-31', 1), '2026-11-01')
  eq(wc.wcAddDays('2026-10-31', 2), '2026-11-02')
  eq(wc.wcAddDays('2026-11-02', -2), '2026-10-31')
  eq(wc.wcDayDiff('2026-10-31', '2026-11-02'), 2)
})
test('Date math survives the Mar 14 2027 DST spring-forward', function() {
  eq(wc.wcAddDays('2027-03-13', 2), '2027-03-15')
  eq(wc.wcDayDiff('2027-03-13', '2027-03-15'), 2)
})
test('Monday-of: a Sunday belongs to the week that started the previous Monday', function() {
  eq(wc.wcMondayOf('2026-09-27'), '2026-09-21', 'Sunday')
  eq(wc.wcMondayOf('2026-09-21'), '2026-09-21', 'Monday')
  eq(wc.wcMondayOf('2026-09-23'), '2026-09-21', 'Wednesday')
})

// ── Period bounds ──
test('1W on Wed Sep 23 2026 is Mon Sep 21 – Sun Sep 27', function() {
  var b = bounds('1W', 0, '2026-09-23')
  eq(b.start, '2026-09-21'); eq(b.end, '2026-09-27'); eq(b.days, 7); eq(b.label, 'Sep 21 – 27')
})
test('1W offset -1 steps back exactly one week', function() {
  var b = bounds('1W', -1, '2026-09-23')
  eq(b.start, '2026-09-14'); eq(b.end, '2026-09-20')
})
test('1W spanning two months is labelled with both', function() {
  var b = bounds('1W', 0, '2026-10-01')
  eq(b.start, '2026-09-28'); eq(b.end, '2026-10-04'); eq(b.label, 'Sep 28 – Oct 4')
})
test('1W spanning the DST change still has 7 days', function() {
  var a = bounds('1W', 0, '2026-11-01')   // Sunday of the change
  eq(a.start, '2026-10-26'); eq(a.end, '2026-11-01'); eq(a.days, 7)
  var b = bounds('1W', 0, '2026-11-03')
  eq(b.start, '2026-11-02'); eq(b.end, '2026-11-08'); eq(b.days, 7)
})
test('1W spanning New Year crosses the year and shows it', function() {
  var b = bounds('1W', 0, '2026-12-31')
  eq(b.start, '2026-12-28'); eq(b.end, '2027-01-03'); eq(b.label, 'Dec 28 – Jan 3, 2027')
})
test('2W is last week + this week, stepping two weeks at a time', function() {
  var b = bounds('2W', 0, '2026-09-23')
  eq(b.start, '2026-09-14'); eq(b.end, '2026-09-27'); eq(b.days, 14)
  var c = bounds('2W', -1, '2026-09-23')
  eq(c.start, '2026-08-31'); eq(c.end, '2026-09-13')
})
test('1M is the calendar month; on Oct 5 offset -1 is all of September', function() {
  var b = bounds('1M', 0, '2026-10-05')
  eq(b.start, '2026-10-01'); eq(b.end, '2026-10-31'); eq(b.days, 31); eq(b.label, 'October')
  var s = bounds('1M', -1, '2026-10-05')
  eq(s.start, '2026-09-01'); eq(s.end, '2026-09-30'); eq(s.days, 30); eq(s.label, 'September')
})
test('1M handles February and leap years', function() {
  eq(bounds('1M', 0, '2027-02-10').days, 28)
  eq(bounds('1M', 0, '2028-02-10').days, 29)
})
test('1M offset across a year boundary labels the year', function() {
  var b = bounds('1M', -1, '2027-01-15')
  eq(b.start, '2026-12-01'); eq(b.end, '2026-12-31'); eq(b.label, 'December 2026')
})
test('3M is this month + two before, stepping three months', function() {
  var b = bounds('3M', 0, '2026-09-23')
  eq(b.start, '2026-07-01'); eq(b.end, '2026-09-30'); eq(b.days, 92); eq(b.label, 'Jul – Sep')
  var c = bounds('3M', -1, '2026-09-23')
  eq(c.start, '2026-04-01'); eq(c.end, '2026-06-30')
})
test('All uses the supplied range and ignores offset', function() {
  var b = bounds('All', -3, '2026-09-23', { start: '2026-09-01', end: '2026-09-23' })
  eq(b.start, '2026-09-01'); eq(b.end, '2026-09-23'); eq(b.days, 23)
})

// ── Plan / phases ──
var LOSE = { start_date: '2026-09-01', end_date: null, start_weight: 176, target_weight: 146, lbs_per_day: 0.2 }

test('Phase rate: deficit for loss, surplus for gain, 0 when calories point the wrong way', function() {
  near(wc.wcPhaseRate(176, 146, 2000, 2500), 500 / 3500, 'lose')
  near(wc.wcPhaseRate(150, 160, 3000, 2500), 500 / 3500, 'gain')
  eq(wc.wcPhaseRate(176, 146, 2600, 2500), 0, 'lose with surplus')
  eq(wc.wcPhaseRate(176, 146, 2000, null), 0, 'no TDEE')
  eq(wc.wcPhaseRate(150, 150, 2000, 2500), 0, 'maintain')
})
test('Plan line descends, then stays flat at target forever', function() {
  eq(wc.wcPlanWeightAtDay(LOSE, 0), 176)
  near(wc.wcPlanWeightAtDay(LOSE, 50), 166)
  eq(wc.wcPlanWeightAtDay(LOSE, 150), 146, 'exactly at target')
  eq(wc.wcPlanWeightAtDay(LOSE, 900), 146, 'two years later')
  eq(wc.wcPlanWeightAtDay(LOSE, -1), null, 'before the phase started')
})
test('Gain and maintain phases plan correctly; no rate means no plan', function() {
  var gain = { start_weight: 150, target_weight: 160, lbs_per_day: 0.1 }
  near(wc.wcPlanWeightAtDay(gain, 50), 155); eq(wc.wcPlanWeightAtDay(gain, 500), 160)
  eq(wc.wcPlanWeightAtDay({ start_weight: 150, target_weight: 150, lbs_per_day: 0 }, 30), 150)
  eq(wc.wcPlanWeightAtDay({ start_weight: 176, target_weight: 146, lbs_per_day: 0 }, 30), null)
})
test('Phase lookup respects start/end dates and the active phase', function() {
  var old = { start_date: '2026-01-01', end_date: '2026-09-22', start_weight: 190, target_weight: 176, lbs_per_day: 0.1 }
  var cur = { start_date: '2026-09-23', end_date: null, start_weight: 176, target_weight: 146, lbs_per_day: 0.2 }
  var phases = [old, cur]
  eq(wc.wcPhaseForDate(phases, '2025-12-31'), null, 'before any phase')
  eq(wc.wcPhaseForDate(phases, '2026-09-22'), old, 'last day of old phase')
  eq(wc.wcPhaseForDate(phases, '2026-09-23'), cur, 'first day of new phase')
  eq(wc.wcPhaseForDate(phases, '2028-01-01'), cur, 'far future')
})
test('Plan segments: a phase starting mid-week begins at its start day, not the left edge', function() {
  var p = { start_date: '2026-09-23', end_date: null, start_weight: 176, target_weight: 146, lbs_per_day: 0.2 }
  var segs = wc.wcPlanSegments([p], '2026-09-21', 7)
  eq(segs.length, 1); eq(segs[0].uA, 2); eq(segs[0].uB, 6.5)
  eq(segs[0].pts[0].w, 176)
})
test('Plan segments: a reset mid-week produces two segments that do not overlap', function() {
  var old = { start_date: '2026-09-01', end_date: '2026-09-22', start_weight: 180, target_weight: 170, lbs_per_day: 0.1 }
  var cur = { start_date: '2026-09-23', end_date: null, start_weight: 176, target_weight: 146, lbs_per_day: 0.2 }
  var segs = wc.wcPlanSegments([old, cur], '2026-09-21', 7)
  eq(segs.length, 2)
  eq(segs[0].uA, -0.5); eq(segs[0].uB, 1)
  eq(segs[1].uA, 2)
})
test('Plan segments: the day the target is hit becomes a vertex, then the line is flat', function() {
  // hits 146 on day 150 = 2027-01-29
  var segs = wc.wcPlanSegments([LOSE], '2027-01-01', 31)
  var pts = segs[0].pts
  eq(pts.length, 3, 'start, hit, end')
  eq(pts[1].w, 146); eq(pts[2].w, 146)
  near(pts[1].u, 28)
})
test('Weekly buckets average Mon–Sun and sit mid-week', function() {
  var e = [{ date: '2026-09-21', weight: 176 }, { date: '2026-09-23', weight: 175 }, { date: '2026-09-28', weight: 174 }]
  var w = wc.wcBucketWeights(e, 'week')
  eq(w.length, 2); eq(w[0].weight, 175.5); eq(w[0].date, '2026-09-24'); eq(w[1].weekStart, '2026-09-28')
})
test('Period change measures from the last weigh-in before the period', function() {
  var e = [{ date: '2026-09-18', weight: 177 }, { date: '2026-09-21', weight: 176.4 }, { date: '2026-09-23', weight: 175.6 }]
  var c = wc.wcPeriodChange(e, [LOSE], bounds('1W', 0, '2026-09-23'))
  eq(c.actual, -1.4); eq(c.from, '2026-09-18'); eq(c.to, '2026-09-23')
  eq(c.plan, -1)   // 5 days x 0.2
})
test('Period change on a Monday with one weigh-in and no history returns null', function() {
  var c = wc.wcPeriodChange([{ date: '2026-09-21', weight: 176 }], [LOSE], bounds('1W', 0, '2026-09-21'))
  eq(c, null)
})
test('Period change does not compare against the plan across a phase reset', function() {
  var maintain = { start_date: '2025-06-16', end_date: '2026-08-31', start_weight: 165, target_weight: 165, lbs_per_day: 0 }
  var cur = { start_date: '2026-09-01', end_date: null, start_weight: 176, target_weight: 146, lbs_per_day: 0.24 }
  var e = [{ date: '2026-08-30', weight: 176.3 }, { date: '2026-09-01', weight: 176.1 }, { date: '2026-09-05', weight: 174.8 }]
  var c = wc.wcPeriodChange(e, [maintain, cur], bounds('1W', 0, '2026-09-02'))
  eq(c.actual, -1.5); eq(c.plan, null, 'plan must not read as +10 lb'); eq(c.crossesPhase, true)
})
test('Chunks: a month splits into Mon–Sun weeks clipped at the edges', function() {
  var ch = wc.wcChunks('2026-09-01', '2026-09-30', 'week')
  eq(ch[0].start, '2026-09-01'); eq(ch[0].end, '2026-09-06')
  eq(ch[ch.length - 1].start, '2026-09-28'); eq(ch[ch.length - 1].end, '2026-09-30')
  var m = wc.wcChunks('2026-08-15', '2026-10-10', 'month')
  eq(m.length, 3); eq(m[1].start, '2026-09-01'); eq(m[1].end, '2026-09-30')
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed > 0 ? 1 : 0)
