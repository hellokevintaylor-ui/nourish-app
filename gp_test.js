// Game plan scheduling tests
// Run with: node gp_test.js

// ── PASTE FUNCTIONS FROM main.js ──
function gpParseTime(t) {
  if (!t) return 0
  t = String(t).replace(/(\d)(\s*)(p)\b/i,'$1$2pm').replace(/(\d)(\s*)(a)\b/i,'$1$2am')
  var m = t.match(/(\d+):?(\d*)\s*(am|pm)/i)
  if (!m) return 0
  var h=parseInt(m[1]),min=parseInt(m[2]||'0'),ampm=m[3].toUpperCase()
  if(ampm==='PM'&&h!==12)h+=12; if(ampm==='AM'&&h===12)h=0
  return h*60+min
}
function gpFormatTime(totalMins) {
  if (totalMins < 0) return 'Night Before'
  var h=Math.floor(totalMins/60)%24, min=totalMins%60
  var ap=h>=12?'PM':'AM'; if(h>12)h-=12; if(h===0)h=12
  return h+':'+(min<10?'0'+min:min)+' '+ap
}
function gpNormalizeTime2(t) {
  if (!t) return 0
  t = String(t).trim().replace(/(\d)(\s*)(p)\b/i,'$1$2pm').replace(/(\d)(\s*)(a)\b/i,'$1$2am')
  if (!/am|pm/i.test(t)) t += ' PM'
  return gpParseTime(t)
}

// Simulate gpParseConstraints window extraction
function extractWindows(notes, dinnerMins) {
  var cleanNotes = notes.replace(/CURRENT TIME[^\n]*/gi, '').replace(/TARGET MEAL TIME[^\n]*/gi, '')
  var lower = cleanNotes.toLowerCase()
  var rawWindows = []

  var rangeRe = /(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p))\s*(?:to|-|\u2013|until|till)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)|(\d{1,2}(?::\d{2})?)\s*(?:to|-|\u2013|until|till)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p))/gi
  var m
  while ((m = rangeRe.exec(lower)) !== null) {
    var t1=(m[1]||m[3]||'').trim(), t2=(m[2]||m[4]||'').trim()
    if (!t1||!t2) continue
    var s=gpNormalizeTime2(t1), e=gpNormalizeTime2(t2)
    if (s>0&&e>s&&e<=dinnerMins) rawWindows.push({startMins:s,endMins:e})
  }

  var betweenRe = /between\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)\s*(?:and|to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)/gi
  while ((m = betweenRe.exec(lower)) !== null) {
    var s=gpNormalizeTime2(m[1]), e=gpNormalizeTime2(m[2])
    if (s>0&&e>s&&!rawWindows.find(function(w){return Math.abs(w.startMins-s)<5})) rawWindows.push({startMins:s,endMins:e})
  }
  rawWindows.sort(function(a,b){return a.startMins-b.startMins})

  var cookRe = lower.match(/(?:start(?:\s+(?:cooking|the))?|back|resume|return|then\s+(?:back|cook)|final\s+cooking|cooking\s+push)(?:\s+(?:cooking|prep|push|again|the|final))*(?:\s+(?:at|from))?\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?)/i)
  var cookStartMins = cookRe ? gpNormalizeTime2(cookRe[1]) : 0

  var nightBefore = /night before|tonight|this evening|the night before/i.test(lower)
  var morning = /morning|next morning|tomorrow morning/i.test(lower)

  var windows = []
  if (rawWindows.length > 0) {
    if (nightBefore) windows.push({label:'night_before', startMins:-60, endMins:0})
    rawWindows.forEach(function(w,i) {
      var lbl = windows.length===0 ? (rawWindows.length>1?'morning_prep':'prep') :
               i===0 ? 'morning_prep' : i===1 ? 'afternoon_prep' : 'prep_'+(i+1)
      windows.push({label:lbl, startMins:w.startMins, endMins:w.endMins})
    })
    var lastRaw = rawWindows[rawWindows.length-1]
    var lastIsCooking = Math.abs(lastRaw.endMins - dinnerMins) < 10
    if (lastIsCooking) {
      windows[windows.length-1].label = 'cooking'
    } else {
      var cookStart = cookStartMins > 0 ? cookStartMins : lastRaw.endMins
      if (cookStart < dinnerMins) windows.push({label:'cooking', startMins:cookStart, endMins:dinnerMins})
    }
  } else if (nightBefore || morning || cookStartMins > 0) {
    if (nightBefore) windows.push({label:'night_before', startMins:-60, endMins:0})
    if (morning) windows.push({label:'morning_prep', startMins:1, endMins:2})
    if (cookStartMins > 0) windows.push({label:'cooking', startMins:cookStartMins, endMins:dinnerMins})
  }

  return windows
}

// Place steps into windows (simplified gpBuildTimeline)
function buildTimeline(steps, windows, dinnerMins, targetTime) {
  var result = []
  var assigned = {}
  windows.forEach(function(w) { assigned[w.label] = [] })
  steps.forEach(function(s) {
    var lbl = (s.window||'').toLowerCase().replace(/\s+/g,'_')
    if (lbl && assigned[lbl]) assigned[lbl].push(s)
    else {
      var matched = Object.keys(assigned).find(function(k){return lbl.includes(k)||k.includes(lbl)})
      if (matched) assigned[matched].push(s)
      else assigned[windows[windows.length-1].label].push(s)
    }
  })

  windows.forEach(function(w, wi) {
    var wSteps = assigned[w.label] || []
    if (!wSteps.length) return
    var isLast = wi === windows.length-1
    var isLabel = w.startMins <= 0 || (w.startMins===1&&w.endMins===2)

    if (isLast && !isLabel) {
      // Backwards from dinner
      var cc = w.endMins
      var rev = wSteps.slice().reverse()
      var placed = []
      rev.forEach(function(s) {
        var dur = Math.max((s.active_min||0)+(s.passive_min||0), 5)
        cc -= dur
        if (cc < w.startMins) cc = w.startMins
        placed.unshift({time: gpFormatTime(cc), step: s.step, window: w.label})
      })
      placed.forEach(function(p){result.push(p)})
    } else if (isLabel) {
      wSteps.forEach(function(s,si){result.push({time: si===0?w.label.replace('_',' '):'↓', step:s.step, window:w.label})})
    } else {
      var c2 = w.startMins
      wSteps.forEach(function(s){
        var dur = Math.max((s.active_min||0)+(s.passive_min||0),5)
        result.push({time:gpFormatTime(c2), step:s.step, window:w.label})
        c2+=dur
      })
    }
  })
  result.push({time:targetTime, step:'Dinner is served 🍽️'})
  return result
}

// ── TEST RUNNER ──
var passed = 0, failed = 0
function test(name, fn) {
  try {
    fn()
    console.log('✅ ' + name)
    passed++
  } catch(e) {
    console.log('❌ ' + name + '\n   ' + e.message)
    failed++
  }
}
function assert(condition, msg) { if (!condition) throw new Error(msg) }
function assertWindow(windows, idx, label, startStr, endStr) {
  var w = windows[idx]
  assert(w, 'window['+idx+'] missing')
  assert(w.label === label, 'window['+idx+'].label: expected '+label+' got '+w.label)
  if (startStr) {
    var expected = gpParseTime(startStr)
    assert(Math.abs(w.startMins - expected) < 5, 'window['+idx+'].startMins: expected '+startStr+'('+expected+') got '+w.startMins)
  }
  if (endStr) {
    var expected2 = gpParseTime(endStr)
    assert(Math.abs(w.endMins - expected2) < 5, 'window['+idx+'].endMins: expected '+endStr+'('+expected2+') got '+w.endMins)
  }
}
function firstStepTime(timeline) { return gpParseTime(timeline[0].time) }
function lastCookStep(timeline) {
  // Last step before "Dinner is served"
  return timeline[timeline.length-2]
}

// ════════════════════════════════════════════
// SCENARIO 1: Simple - start at 5:30p, eat at 7p
// ════════════════════════════════════════════
test('Scenario 1: Simple start time', function() {
  var notes = 'User constraint: i can start cooking at 5:30p\nUser constraint: eat at 7pm'
  var dinnerMins = gpParseTime('7:00 PM')
  var windows = extractWindows(notes, dinnerMins)
  assert(windows.length > 0, 'should have at least 1 window')
  assertWindow(windows, 0, 'cooking', '5:30 PM', '7:00 PM')
  
  var steps = [
    {step:'Season chicken', active_min:5, passive_min:0, window:'cooking'},
    {step:'Roast chicken', active_min:5, passive_min:40, window:'cooking'},
    {step:'Rest chicken', active_min:0, passive_min:10, window:'cooking'},
    {step:'Plate and serve', active_min:5, passive_min:0, window:'cooking'},
  ]
  var timeline = buildTimeline(steps, windows, dinnerMins, '7:00 PM')
  var lastCook = lastCookStep(timeline)
  var lastTime = gpParseTime(lastCook.time)
  assert(lastTime + 5 <= dinnerMins, 'last step should finish at or before 7PM, ends at '+gpFormatTime(lastTime+5))
  assert(firstStepTime(timeline) >= gpParseTime('5:30 PM'), 'first step should be at or after 5:30PM')
})

// ════════════════════════════════════════════
// SCENARIO 2: Prep window + gap + cooking
// ════════════════════════════════════════════
test('Scenario 2: Prep 1-2pm, resume 5:30p, eat 6:30p', function() {
  var notes = 'User constraint: prep between 1p and 2p, then resume cooking at 5:30p'
  var dinnerMins = gpParseTime('6:30 PM')
  var windows = extractWindows(notes, dinnerMins)
  assert(windows.length >= 2, 'should have prep + cooking windows, got ' + windows.length)
  assertWindow(windows, 0, 'prep', '1:00 PM', '2:00 PM')
  assertWindow(windows, windows.length-1, 'cooking', '5:30 PM', '6:30 PM')
  
  var steps = [
    {step:'Toast pine nuts', active_min:5, passive_min:0, window:'prep'},
    {step:'Make vinaigrette', active_min:8, passive_min:0, window:'prep'},
    {step:'Roast potatoes', active_min:5, passive_min:45, window:'cooking'},
    {step:'Plate', active_min:5, passive_min:0, window:'cooking'},
  ]
  var timeline = buildTimeline(steps, windows, dinnerMins, '6:30 PM')
  var prepStep = timeline.find(function(s){return s.window==='prep'})
  var cookSteps = timeline.filter(function(s){return s.window==='cooking'})
  assert(prepStep && gpParseTime(prepStep.time) >= gpParseTime('1:00 PM'), 'prep starts at 1pm+')
  assert(prepStep && gpParseTime(prepStep.time) < gpParseTime('2:00 PM'), 'prep ends before 2pm')
  assert(cookSteps.length > 0, 'has cooking steps')
  assert(gpParseTime(cookSteps[0].time) >= gpParseTime('5:30 PM'), 'cooking starts at 5:30pm+')
})

// ════════════════════════════════════════════
// SCENARIO 3: Three explicit windows
// ════════════════════════════════════════════
test('Scenario 3: 8a-9a, 1p-2p, cooking 5p-7:30p', function() {
  var notes = 'User constraint: window from 8a to 9a, then another window from 1p to 2p, then cooking from 5p to 7:30p'
  var dinnerMins = gpParseTime('7:30 PM')
  var windows = extractWindows(notes, dinnerMins)
  assert(windows.length === 3, 'should have 3 windows, got ' + windows.length + ': ' + windows.map(function(w){return w.label}).join(','))
  assertWindow(windows, 0, 'morning_prep', '8:00 AM', '9:00 AM')
  assertWindow(windows, 1, 'afternoon_prep', '1:00 PM', '2:00 PM')
  assertWindow(windows, 2, 'cooking', '5:00 PM', '7:30 PM')
})

// ════════════════════════════════════════════
// SCENARIO 4: Night before + morning + cooking
// ════════════════════════════════════════════
test('Scenario 4: Night before, morning, cook at 6p, eat at 8p', function() {
  var notes = 'User constraint: night before i have an hour. morning, some more things. start cooking at 6p for dinner at 8p'
  var dinnerMins = gpParseTime('8:00 PM')
  var windows = extractWindows(notes, dinnerMins)
  assert(windows.some(function(w){return w.label==='night_before'}), 'should have night_before window')
  assert(windows.some(function(w){return w.label==='morning_prep'}), 'should have morning_prep window')
  assert(windows.some(function(w){return w.label==='cooking'}), 'should have cooking window')
  var cookWin = windows.find(function(w){return w.label==='cooking'})
  assert(Math.abs(cookWin.startMins - gpParseTime('6:00 PM')) < 5, 'cooking starts at 6pm')
})

// ════════════════════════════════════════════
// SCENARIO 5: Tonight + 10a-12p + resume 5:30p
// ════════════════════════════════════════════
test('Scenario 5: Tonight + 10a-12p window + resume 5:30p, eat 7p', function() {
  var notes = 'User constraint: i can do some prep tonight. then i have a window between 10a and 12p to do more prep. i can resume the final cooking push at 5:30p for dinner at 7p'
  var dinnerMins = gpParseTime('7:00 PM')
  var windows = extractWindows(notes, dinnerMins)
  assert(windows.some(function(w){return w.label==='night_before'}), 'should have night_before')
  assert(windows.some(function(w){return w.label==='morning_prep'}), 'should have morning_prep 10a-12p')
  assert(windows.some(function(w){return w.label==='cooking'}), 'should have cooking window')
  var cookWin = windows.find(function(w){return w.label==='cooking'})
  assert(Math.abs(cookWin.startMins - gpParseTime('5:30 PM')) < 5, 'cooking starts at 5:30pm, got ' + gpFormatTime(cookWin.startMins))
})

// ════════════════════════════════════════════
// SCENARIO 6: Backwards anchor - food hot at dinner
// ════════════════════════════════════════════
test('Scenario 6: Cooking steps land hot at dinner time', function() {
  var windows = [{label:'cooking', startMins:gpParseTime('5:30 PM'), endMins:gpParseTime('7:00 PM')}]
  var steps = [
    {step:'Preheat oven', active_min:2, passive_min:0, window:'cooking'},
    {step:'Season chicken', active_min:5, passive_min:0, window:'cooking'},
    {step:'Roast chicken', active_min:3, passive_min:45, window:'cooking'},
    {step:'Rest chicken 10 min', active_min:0, passive_min:10, window:'cooking'},
    {step:'Plate and serve', active_min:5, passive_min:0, window:'cooking'},
  ]
  var timeline = buildTimeline(steps, windows, gpParseTime('7:00 PM'), '7:00 PM')
  var lastCook = lastCookStep(timeline)
  var lastEndTime = gpParseTime(lastCook.time) + (5) // plate step = 5min active
  assert(Math.abs(lastEndTime - gpParseTime('7:00 PM')) <= 5, 
    'last cooking step should finish at ~7PM, got ' + gpFormatTime(lastEndTime))
  assert(gpParseTime(timeline[0].time) >= gpParseTime('5:30 PM'),
    'first step at or after 5:30pm, got ' + timeline[0].time)
})

// ════════════════════════════════════════════
// SCENARIO 7: No false positives - "4-5 minutes" shouldn't be a window
// ════════════════════════════════════════════  
test('Scenario 7: Duration ranges not mistaken for time windows', function() {
  var notes = 'User constraint: start at 5pm. simmer for 4-5 minutes. roast for 10 to 15 minutes.'
  var dinnerMins = gpParseTime('7:00 PM')
  var windows = extractWindows(notes, dinnerMins)
  if (windows.length > 0) {
    windows.forEach(function(w) {
      assert(w.startMins >= gpParseTime('4:00 PM'), 
        'window '+w.label+' startMins='+w.startMins+' looks like a duration not a time')
    })
  }
})

console.log('\n' + passed + ' passed, ' + failed + ' failed')
