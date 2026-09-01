/* ============================================================
   MindSpark - prompt template data.

   Split out of app.js purely for file size: this is ~870 lines of
   static data with no logic, and keeping it here makes app.js
   meaningfully easier to read and diff.

   Loaded BEFORE app.js (see index.html). That order matters - these
   are `const` declarations, so anything reading them before this
   file has run would hit the temporal dead zone. Nothing does today
   (only functions reference them, and those run on user action), but
   loading this first makes the order correct by construction rather
   than by luck.
   ============================================================ */

const TEMPLATES = {
  /* ===== AI & agents (flagship) ===== */
  agent_architecture: {
    name:'AI Agent Architecture', desc:'The anatomy of a single agent: model, memory, planning, tools, loop & guardrails', color:'#8c5da7', group:'ai', icon:'🧠', layout:'radial',
    nodes:[
      { k:'root', text:'AI Agent Architecture', notes:'<p>The anatomy of a single AI agent \u2014 the model at its core, what it remembers, how it plans, the tools it can call, and the loop &amp; guardrails that keep it on track.</p>' },
      { k:'model', parent:'root', text:'Model (LLM core)' },
      { k:'m1', parent:'model', text:'Reasoning engine' },
      { k:'m2', parent:'model', text:'Model choice (capability vs cost)' },
      { k:'m3', parent:'model', text:'Context window' },
      { k:'m4', parent:'model', text:'System prompt' },
      { k:'memory', parent:'root', text:'Memory' },
      { k:'mem1', parent:'memory', text:'Short-term (scratchpad)' },
      { k:'mem2', parent:'memory', text:'Long-term (vector store)' },
      { k:'mem3', parent:'memory', text:'Episodic' },
      { k:'mem4', parent:'memory', text:'Working state' },
      { k:'plan', parent:'root', text:'Planning' },
      { k:'p1', parent:'plan', text:'Task decomposition' },
      { k:'p2', parent:'plan', text:'ReAct (reason + act)' },
      { k:'p3', parent:'plan', text:'Chain-of-thought' },
      { k:'p4', parent:'plan', text:'Reflection / self-critique' },
      { k:'p5', parent:'plan', text:'Re-planning' },
      { k:'tools', parent:'root', text:'Tools / Actions' },
      { k:'t1', parent:'tools', text:'Function calling' },
      { k:'t2', parent:'tools', text:'APIs' },
      { k:'t3', parent:'tools', text:'Code execution' },
      { k:'t4', parent:'tools', text:'Web search / retrieval' },
      { k:'t5', parent:'tools', text:'MCP servers' },
      { k:'loop', parent:'root', text:'Control loop' },
      { k:'l1', parent:'loop', text:'Observe \u2192 reason \u2192 act' },
      { k:'l2', parent:'loop', text:'Stopping criteria' },
      { k:'l3', parent:'loop', text:'Retries / error handling' },
      { k:'guard', parent:'root', text:'Guardrails' },
      { k:'g1', parent:'guard', text:'Input validation' },
      { k:'g2', parent:'guard', text:'Output checks' },
      { k:'g3', parent:'guard', text:'Human-in-the-loop' },
      { k:'g4', parent:'guard', text:'Cost / rate limits' },
      { k:'out', parent:'root', text:'Output' },
      { k:'o1', parent:'out', text:'Final response' },
      { k:'o2', parent:'out', text:'Structured output' },
      { k:'o3', parent:'out', text:'Side effects (writes, calls)' }
    ],
    links:[ { from:'loop', to:'tools' }, { from:'loop', to:'memory' }, { from:'plan', to:'model' } ]
  },
  agentic_patterns: {
    name:'Agentic Workflow Patterns', desc:'From an augmented LLM to autonomous agents \u2014 and how to choose between them', color:'#2f6f6a', group:'ai', icon:'🔀', layout:'fishbone',
    nodes:[
      { k:'root', text:'Agentic Workflow Patterns', notes:'<p>Common patterns for building agentic systems, from a single augmented LLM up to autonomous agents \u2014 and how to choose between them. Rule of thumb: prefer the <strong>simplest pattern that works</strong>.</p>' },
      { k:'aug', parent:'root', text:'Augmented LLM (foundation)' },
      { k:'au1', parent:'aug', text:'Retrieval' },
      { k:'au2', parent:'aug', text:'Tools' },
      { k:'au3', parent:'aug', text:'Memory' },
      { k:'chain', parent:'root', text:'Prompt chaining' },
      { k:'c1', parent:'chain', text:'Sequential steps' },
      { k:'c2', parent:'chain', text:'Gate checks between steps' },
      { k:'route', parent:'root', text:'Routing' },
      { k:'r1', parent:'route', text:'Classify the input' },
      { k:'r2', parent:'route', text:'Send to a specialized path' },
      { k:'par', parent:'root', text:'Parallelization' },
      { k:'pa1', parent:'par', text:'Sectioning (split the work)' },
      { k:'pa2', parent:'par', text:'Voting (run N, aggregate)' },
      { k:'orch', parent:'root', text:'Orchestrator\u2013workers' },
      { k:'or1', parent:'orch', text:'Dynamic subtasks' },
      { k:'or2', parent:'orch', text:'Synthesize results' },
      { k:'evo', parent:'root', text:'Evaluator\u2013optimizer' },
      { k:'e1', parent:'evo', text:'Generate' },
      { k:'e2', parent:'evo', text:'Critique' },
      { k:'e3', parent:'evo', text:'Refine (loop)' },
      { k:'auto', parent:'root', text:'Autonomous agent' },
      { k:'at1', parent:'auto', text:'Open-ended loop' },
      { k:'at2', parent:'auto', text:'Tool use' },
      { k:'at3', parent:'auto', text:'Human checkpoints' },
      { k:'choose', parent:'root', text:'Choosing a pattern' },
      { k:'ch1', parent:'choose', text:'Complexity vs cost vs latency' },
      { k:'ch2', parent:'choose', text:'Prefer the simplest that works' }
    ],
    links:[ { from:'auto', to:'aug' } ]
  },
  claude_skill: {
    name:'Claude Agent Skill', desc:'Scaffold a SKILL.md - instructions Claude loads dynamically for a specialized task',
    color:'#8c5da7', group:'ai', icon:'🧩', layout:'down',
    nodes:[
      { k:'root', text:'My Skill Name', notes:'<p>A <strong>Skill</strong> is a folder with a <code>SKILL.md</code> file that teaches Claude how to do a specific task in a repeatable way \u2014 e.g. following your brand guidelines, or your team\u2019s specific workflow. The YAML block below is the file\u2019s required frontmatter; edit its table like any other node. See <a href="https://github.com/anthropics/skills" target="_blank" rel="noopener noreferrer">github.com/anthropics/skills</a>.</p>' },
      { k:'fm', parent:'root', text:'', frontmatter:true,
        html:'<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody><tr><td>name</td><td>my-skill-name</td></tr><tr><td>description</td><td>A clear description of what this skill does and when to use it</td></tr></tbody></table>' },
      { k:'instr', parent:'root', text:'Add your instructions here that Claude will follow when this skill is active' },
      { k:'ex',  parent:'root', text:'Examples' },
      { k:'ex1', parent:'ex',   text:'Example usage 1' },
      { k:'ex2', parent:'ex',   text:'Example usage 2' },
      { k:'gl',  parent:'root', text:'Guidelines' },
      { k:'gl1', parent:'gl',   text:'Guideline 1' },
      { k:'gl2', parent:'gl',   text:'Guideline 2' }
    ]
  },
  rtcce: {
    name: 'Role / Task / Context / Constraints / Examples',
    desc: 'Classic structured prompt - the bread-and-butter shape',
    color: '#5b8db2', group:'prompt', icon:'⊟', layout:'right',
    nodes: [
      { k:'root', text:'Prompt: [your task]' },
      { k:'r',   parent:'root', text:'Role' },
      { k:'r1',  parent:'r',    text:'You are a senior …' },
      { k:'t',   parent:'root', text:'Task' },
      { k:'t1',  parent:'t',    text:'[describe what to do]' },
      { k:'c',   parent:'root', text:'Context' },
      { k:'c1',  parent:'c',    text:'[background information]' },
      { k:'cn',  parent:'root', text:'Constraints' },
      { k:'cn1', parent:'cn',   text:'[what to avoid / formatting rules]' },
      { k:'e',   parent:'root', text:'Examples' },
      { k:'e1',  parent:'e',    text:'[input / expected output]' }
    ]
  },
  cot: {
    name: 'Chain-of-Thought',
    desc: 'Step-by-step reasoning prompt',
    color: '#6a8c3f', group:'prompt', icon:'⟶', layout:'timeline',
    nodes: [
      { k:'root', text:'Reasoning prompt' },
      { k:'q',   parent:'root', text:'Question' },
      { k:'q1',  parent:'q',    text:'[the question to solve]' },
      { k:'a',   parent:'root', text:'Approach' },
      { k:'a1',  parent:'a',    text:'Think step by step.' },
      { k:'a2',  parent:'a',    text:'Identify the sub-problems.' },
      { k:'a3',  parent:'a',    text:'Solve each sub-problem in order.' },
      { k:'a4',  parent:'a',    text:'Combine into a final answer.' },
      { k:'o',   parent:'root', text:'Output format' },
      { k:'o1',  parent:'o',    text:'Show your reasoning, then the final answer in <answer> tags.' }
    ]
  },
  fc: {
    name: 'Function-calling schema',
    desc: 'Tool / function definition outline',
    color: '#8c5da7', group:'prompt', icon:'ƒ', layout:'grid',
    nodes: [
      { k:'root', text:'function_name' },
      { k:'d',   parent:'root', text:'Description' },
      { k:'d1',  parent:'d',    text:'[what this function does, when to call it]' },
      { k:'p',   parent:'root', text:'Parameters' },
      { k:'p1',  parent:'p',    text:'param_a (string, required)' },
      { k:'p2',  parent:'p',    text:'param_b (number, optional)' },
      { k:'p3',  parent:'p',    text:'param_c (enum: a | b | c)' },
      { k:'r',   parent:'root', text:'Returns' },
      { k:'r1',  parent:'r',    text:'[shape of the return value]' },
      { k:'e',   parent:'root', text:'Error modes' },
      { k:'e1',  parent:'e',    text:'[when it fails, what it returns]' }
    ]
  },
  fewshot: {
    name: 'Few-shot examples',
    desc: 'Pattern-by-example prompt',
    color: '#c2783c', group:'prompt', icon:'≡', layout:'timeline',
    nodes: [
      { k:'root', text:'Few-shot prompt' },
      { k:'i',   parent:'root', text:'Instructions' },
      { k:'i1',  parent:'i',    text:'[what to do, format, tone]' },
      { k:'x1',  parent:'root', text:'Example 1' },
      { k:'x1a', parent:'x1',   text:'Input: …' },
      { k:'x1b', parent:'x1',   text:'Output: …' },
      { k:'x2',  parent:'root', text:'Example 2' },
      { k:'x2a', parent:'x2',   text:'Input: …' },
      { k:'x2b', parent:'x2',   text:'Output: …' },
      { k:'q',   parent:'root', text:'Now your turn' },
      { k:'q1',  parent:'q',    text:'Input: [your real input]' }
    ]
  },

  /* ===== Research & academic writing ===== */
  imrad: {
    name: 'Research paper (IMRaD)',
    desc: 'Standard empirical paper skeleton',
    color: '#3a6ea5', group:'research', icon:'📄',
    nodes: [
      { k:'root', text:'Paper title' },
      { k:'ab',  parent:'root', text:'Abstract' },
      { k:'ab1', parent:'ab',   text:'Background' },
      { k:'ab2', parent:'ab',   text:'Methods' },
      { k:'ab3', parent:'ab',   text:'Results' },
      { k:'ab4', parent:'ab',   text:'Conclusion' },
      { k:'in',  parent:'root', text:'Introduction' },
      { k:'in1', parent:'in',   text:'Problem & motivation' },
      { k:'in2', parent:'in',   text:'Gap in the literature' },
      { k:'in3', parent:'in',   text:'Our contribution' },
      { k:'in4', parent:'in',   text:'Paper roadmap' },
      { k:'rw',  parent:'root', text:'Related work' },
      { k:'rw1', parent:'rw',   text:'Theme A' },
      { k:'rw2', parent:'rw',   text:'Theme B' },
      { k:'rw3', parent:'rw',   text:'How we differ' },
      { k:'me',  parent:'root', text:'Methodology' },
      { k:'me1', parent:'me',   text:'Setup' },
      { k:'me2', parent:'me',   text:'Data / dataset' },
      { k:'me3', parent:'me',   text:'Approach' },
      { k:'me4', parent:'me',   text:'Baselines' },
      { k:'re',  parent:'root', text:'Results' },
      { k:'re1', parent:'re',   text:'Main findings' },
      { k:'re2', parent:'re',   text:'Tables & figures' },
      { k:'re3', parent:'re',   text:'Ablations' },
      { k:'di',  parent:'root', text:'Discussion' },
      { k:'di1', parent:'di',   text:'Interpretation' },
      { k:'di2', parent:'di',   text:'Comparison to prior work' },
      { k:'di3', parent:'di',   text:'Limitations' },
      { k:'co',  parent:'root', text:'Conclusion' },
      { k:'co1', parent:'co',   text:'Summary' },
      { k:'co2', parent:'co',   text:'Future work' },
      { k:'rf',  parent:'root', text:'References' }
    ]
  },
  rebuttal: {
    name: 'Reviewer response / rebuttal',
    desc: 'Point-by-point reply for paper revisions',
    color: '#b8451f', group:'research', icon:'✍',
    nodes: [
      { k:'root', text:'Response to reviewers' },
      { k:'su',  parent:'root', text:'Summary of changes' },
      { k:'r1',  parent:'root', text:'Reviewer 1' },
      { k:'r1a', parent:'r1',   text:'Concern 1' },
      { k:'r1a1',parent:'r1a',  text:'Response' },
      { k:'r1a2',parent:'r1a',  text:'Edit made →' },
      { k:'r1b', parent:'r1',   text:'Concern 2' },
      { k:'r1b1',parent:'r1b',  text:'Response' },
      { k:'r2',  parent:'root', text:'Reviewer 2' },
      { k:'r2a', parent:'r2',   text:'Concern 1' },
      { k:'r2a1',parent:'r2a',  text:'Response' },
      { k:'r3',  parent:'root', text:'Reviewer 3' },
      { k:'r3a', parent:'r3',   text:'Concern 1' },
      { k:'r3a1',parent:'r3a',  text:'Response' },
      { k:'ne',  parent:'root', text:'New experiments added' },
      { k:'op',  parent:'root', text:'Open items' }
    ]
  },
  litreview: {
    name: 'Literature review synthesis',
    desc: 'Turn a pile of papers into structure',
    color: '#2f6f6a', group:'research', icon:'📚',
    nodes: [
      { k:'root', text:'Topic' },
      { k:'se',  parent:'root', text:'Seminal works' },
      { k:'cl',  parent:'root', text:'Theme clusters' },
      { k:'cl1', parent:'cl',   text:'Cluster 1 - key claim' },
      { k:'cl2', parent:'cl',   text:'Cluster 2 - key claim' },
      { k:'cl3', parent:'cl',   text:'Cluster 3 - key claim' },
      { k:'ml',  parent:'root', text:'Methods landscape' },
      { k:'gp',  parent:'root', text:'Gaps & open problems' },
      { k:'cn',  parent:'root', text:'Contradictions in the field' },
      { k:'po',  parent:'root', text:'My positioning / contribution' }
    ]
  },
  proposal: {
    name: 'Research proposal',
    desc: 'Grant, fellowship, or project scoping',
    color: '#8c5da7', group:'research', icon:'🎯',
    nodes: [
      { k:'root', text:'Proposal' },
      { k:'ps',  parent:'root', text:'Problem statement' },
      { k:'mo',  parent:'root', text:'Motivation & significance' },
      { k:'rq',  parent:'root', text:'Research questions / hypotheses' },
      { k:'ob',  parent:'root', text:'Objectives' },
      { k:'ob1', parent:'ob',   text:'Aim 1' },
      { k:'ob2', parent:'ob',   text:'Aim 2' },
      { k:'ob3', parent:'ob',   text:'Aim 3' },
      { k:'me',  parent:'root', text:'Methodology' },
      { k:'tl',  parent:'root', text:'Timeline & milestones' },
      { k:'eo',  parent:'root', text:'Expected outcomes' },
      { k:'rk',  parent:'root', text:'Risks & mitigations' }
    ]
  },
  experiment: {
    name: 'Experiment design',
    desc: 'Plan a study before you run it',
    color: '#6a8c3f', group:'research', icon:'🧪',
    nodes: [
      { k:'root', text:'Experiment' },
      { k:'hy',  parent:'root', text:'Hypothesis' },
      { k:'va',  parent:'root', text:'Variables' },
      { k:'va1', parent:'va',   text:'Independent' },
      { k:'va2', parent:'va',   text:'Dependent' },
      { k:'va3', parent:'va',   text:'Controlled' },
      { k:'st',  parent:'root', text:'Setup / apparatus' },
      { k:'pr',  parent:'root', text:'Procedure' },
      { k:'pr1', parent:'pr',   text:'Step 1' },
      { k:'pr2', parent:'pr',   text:'Step 2' },
      { k:'pr3', parent:'pr',   text:'Step 3' },
      { k:'dc',  parent:'root', text:'Data collection' },
      { k:'an',  parent:'root', text:'Analysis plan' },
      { k:'tv',  parent:'root', text:'Threats to validity' }
    ]
  },
  thesis: {
    name: 'Thesis / multi-paper arc',
    desc: 'How separate papers compose into a dissertation',
    color: '#c98a1a', group:'research', icon:'🎓',
    nodes: [
      { k:'root', text:'Central thesis contribution' },
      { k:'p1',  parent:'root', text:'Paper 1' },
      { k:'p1a', parent:'p1',   text:'Research question' },
      { k:'p1b', parent:'p1',   text:'Contribution' },
      { k:'p1c', parent:'p1',   text:'Venue & status' },
      { k:'p2',  parent:'root', text:'Paper 2' },
      { k:'p2a', parent:'p2',   text:'Research question' },
      { k:'p2b', parent:'p2',   text:'Contribution' },
      { k:'p3',  parent:'root', text:'Paper 3' },
      { k:'p3a', parent:'p3',   text:'Research question' },
      { k:'p3b', parent:'p3',   text:'Contribution' },
      { k:'ct',  parent:'root', text:'Cross-cutting theme' },
      { k:'gp',  parent:'root', text:'Gaps still to fill' },
      { k:'ch',  parent:'root', text:'Thesis chapter mapping' }
    ]
  },
  prisma: {
    name: 'Systematic review (PRISMA)',
    desc: 'Formal screening-based review',
    color: '#5b8db2', group:'research', icon:'🔍',
    nodes: [
      { k:'root', text:'Systematic review' },
      { k:'rq',  parent:'root', text:'Research questions' },
      { k:'ss',  parent:'root', text:'Search strategy' },
      { k:'ss1', parent:'ss',   text:'Databases' },
      { k:'ss2', parent:'ss',   text:'Keywords' },
      { k:'ss3', parent:'ss',   text:'Date range' },
      { k:'ic',  parent:'root', text:'Inclusion / exclusion criteria' },
      { k:'sc',  parent:'root', text:'Screening' },
      { k:'sc1', parent:'sc',   text:'Identified' },
      { k:'sc2', parent:'sc',   text:'Screened' },
      { k:'sc3', parent:'sc',   text:'Eligible' },
      { k:'sc4', parent:'sc',   text:'Included' },
      { k:'de',  parent:'root', text:'Data extraction fields' },
      { k:'sy',  parent:'root', text:'Synthesis' },
      { k:'qa',  parent:'root', text:'Quality assessment' }
    ]
  },
  talk: {
    name: 'Conference talk outline',
    desc: 'Structure a research presentation',
    color: '#c2783c', group:'research', icon:'🎤',
    nodes: [
      { k:'root', text:'Talk title' },
      { k:'ho',  parent:'root', text:'Hook' },
      { k:'pr',  parent:'root', text:'Problem' },
      { k:'id',  parent:'root', text:'One key idea' },
      { k:'rh',  parent:'root', text:'Result highlights' },
      { k:'rh1', parent:'rh',   text:'Result 1' },
      { k:'rh2', parent:'rh',   text:'Result 2' },
      { k:'ta',  parent:'root', text:'Takeaway' },
      { k:'bk',  parent:'root', text:'Backup slides' }
    ]
  },
  finer: {
    name: 'Research question (FINER)',
    desc: 'Pressure-test a question before committing',
    color: '#2f6f6a', group:'research', icon:'❓',
    nodes: [
      { k:'root', text:'Research question' },
      { k:'f',  parent:'root', text:'Feasible' },
      { k:'f1', parent:'f',    text:'Time, data, skills, funding?' },
      { k:'i',  parent:'root', text:'Interesting' },
      { k:'i1', parent:'i',    text:'Does the field care?' },
      { k:'n',  parent:'root', text:'Novel' },
      { k:'n1', parent:'n',    text:'What does it add that is new?' },
      { k:'e',  parent:'root', text:'Ethical' },
      { k:'e1', parent:'e',    text:'Approvals / consent / risks?' },
      { k:'r',  parent:'root', text:'Relevant' },
      { k:'r1', parent:'r',    text:'Impact on theory or practice?' }
    ]
  },

  /* ===== Students & educators ===== */
  study_revision: {
    name:'Study / revision map', desc:'Organize a topic for exams', color:'#6a8c3f', group:'study', icon:'📖',
    nodes:[
      { k:'root', text:'Topic' },
      { k:'kc', parent:'root', text:'Key concepts' },
      { k:'df', parent:'root', text:'Definitions' },
      { k:'ex', parent:'root', text:'Examples' },
      { k:'fm', parent:'root', text:'Formulas / rules' },
      { k:'mi', parent:'root', text:'Common mistakes' },
      { k:'eq', parent:'root', text:'Exam questions' },
      { k:'eq1',parent:'eq',   text:'Likely question 1' },
      { k:'eq2',parent:'eq',   text:'Likely question 2' }
    ]
  },
  essay_plan: {
    name:'Essay planner', desc:'Thesis, arguments, evidence', color:'#3a6ea5', group:'study', icon:'✏',
    nodes:[
      { k:'root', text:'Essay question' },
      { k:'th', parent:'root', text:'Thesis statement' },
      { k:'a1', parent:'root', text:'Argument 1' },
      { k:'a1e',parent:'a1',   text:'Evidence' },
      { k:'a2', parent:'root', text:'Argument 2' },
      { k:'a2e',parent:'a2',   text:'Evidence' },
      { k:'a3', parent:'root', text:'Argument 3' },
      { k:'a3e',parent:'a3',   text:'Evidence' },
      { k:'ca', parent:'root', text:'Counterargument' },
      { k:'cr', parent:'ca',   text:'Rebuttal' },
      { k:'co', parent:'root', text:'Conclusion' }
    ]
  },
  lesson_plan: {
    name:'Lesson plan', desc:'For teachers & instructors', color:'#c2783c', group:'study', icon:'🍎',
    nodes:[
      { k:'root', text:'Lesson title' },
      { k:'ob', parent:'root', text:'Learning objectives' },
      { k:'pk', parent:'root', text:'Prior knowledge' },
      { k:'ma', parent:'root', text:'Materials' },
      { k:'ac', parent:'root', text:'Activities' },
      { k:'ac1',parent:'ac',   text:'Warm-up' },
      { k:'ac2',parent:'ac',   text:'Main activity' },
      { k:'ac3',parent:'ac',   text:'Wrap-up' },
      { k:'as', parent:'root', text:'Assessment' },
      { k:'hw', parent:'root', text:'Homework' }
    ]
  },
  cornell: {
    name:'Cornell notes', desc:'Cues, notes, summary', color:'#2f6f6a', group:'study', icon:'🗒',
    nodes:[
      { k:'root', text:'Lecture / chapter' },
      { k:'cu', parent:'root', text:'Cues / questions' },
      { k:'cu1',parent:'cu',   text:'Cue 1' },
      { k:'cu2',parent:'cu',   text:'Cue 2' },
      { k:'no', parent:'root', text:'Notes' },
      { k:'no1',parent:'no',   text:'Main point 1' },
      { k:'no2',parent:'no',   text:'Main point 2' },
      { k:'su', parent:'root', text:'Summary' }
    ]
  },

  /* ===== Software & technical ===== */
  architecture: {
    name:'System architecture', desc:'Services, data, dependencies', color:'#8c5da7', group:'software', icon:'🧩',
    nodes:[
      { k:'root', text:'System name' },
      { k:'cl', parent:'root', text:'Clients' },
      { k:'sv', parent:'root', text:'Services' },
      { k:'sv1',parent:'sv',   text:'Service A' },
      { k:'sv2',parent:'sv',   text:'Service B' },
      { k:'ds', parent:'root', text:'Data stores' },
      { k:'ds1',parent:'ds',   text:'Database' },
      { k:'ds2',parent:'ds',   text:'Cache' },
      { k:'ap', parent:'root', text:'External APIs' },
      { k:'in', parent:'root', text:'Infra / deployment' }
    ]
  },
  sprint: {
    name:'Sprint / feature plan', desc:'Epic → stories → tasks', color:'#3a6ea5', group:'software', icon:'🏃',
    nodes:[
      { k:'root', text:'Epic' },
      { k:'s1', parent:'root', text:'User story 1' },
      { k:'s1t',parent:'s1',   text:'Tasks' },
      { k:'s1a',parent:'s1',   text:'Acceptance criteria' },
      { k:'s2', parent:'root', text:'User story 2' },
      { k:'s2t',parent:'s2',   text:'Tasks' },
      { k:'s2a',parent:'s2',   text:'Acceptance criteria' },
      { k:'de', parent:'root', text:'Definition of done' },
      { k:'ri', parent:'root', text:'Risks / blockers' }
    ]
  },
  postmortem: {
    name:'Incident post-mortem', desc:'Blameless RCA structure', color:'#b8451f', group:'software', icon:'🚨',
    nodes:[
      { k:'root', text:'Incident summary' },
      { k:'tl', parent:'root', text:'Timeline' },
      { k:'tl1',parent:'tl',   text:'Detection' },
      { k:'tl2',parent:'tl',   text:'Response' },
      { k:'tl3',parent:'tl',   text:'Resolution' },
      { k:'im', parent:'root', text:'Impact' },
      { k:'rc', parent:'root', text:'Root cause' },
      { k:'wt', parent:'root', text:'What went well' },
      { k:'ai', parent:'root', text:'Action items' }
    ]
  },
  rfc: {
    name:'Design doc / RFC', desc:'Technical proposal outline', color:'#2f6f6a', group:'software', icon:'📐',
    nodes:[
      { k:'root', text:'RFC title' },
      { k:'co', parent:'root', text:'Context & problem' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'ng', parent:'root', text:'Non-goals' },
      { k:'pr', parent:'root', text:'Proposed design' },
      { k:'al', parent:'root', text:'Alternatives considered' },
      { k:'ri', parent:'root', text:'Risks & trade-offs' },
      { k:'ro', parent:'root', text:'Rollout plan' }
    ]
  },
  ddd: {
    name:'Domain-Driven Design', desc:'Bounded contexts, aggregates, events', color:'#3a6ea5', group:'software', icon:'🧱',
    nodes:[
      { k:'root', text:'Domain' },
      { k:'ul',  parent:'root', text:'Ubiquitous language' },
      { k:'ul1', parent:'ul',   text:'Key term → definition' },
      { k:'bc',  parent:'root', text:'Bounded contexts' },
      { k:'bc1', parent:'bc',   text:'Context A' },
      { k:'bc2', parent:'bc',   text:'Context B' },
      { k:'cm',  parent:'root', text:'Context map' },
      { k:'cm1', parent:'cm',   text:'Relationships (ACL, conformist, …)' },
      { k:'ag',  parent:'root', text:'Aggregates' },
      { k:'ag1', parent:'ag',   text:'Aggregate root' },
      { k:'ag2', parent:'ag',   text:'Invariants / consistency rules' },
      { k:'en',  parent:'root', text:'Entities' },
      { k:'vo',  parent:'root', text:'Value objects' },
      { k:'de',  parent:'root', text:'Domain events' },
      { k:'de1', parent:'de',   text:'Event → handler' },
      { k:'re',  parent:'root', text:'Repositories' },
      { k:'sv',  parent:'root', text:'Domain services' },
      { k:'as',  parent:'root', text:'Application services / use cases' }
    ]
  },

  /* ===== Product & founders ===== */
  prd: {
    name:'PRD (product requirements)', desc:'Problem, users, features, metrics', color:'#c2783c', group:'product', icon:'📝',
    nodes:[
      { k:'root', text:'Product / feature' },
      { k:'pb', parent:'root', text:'Problem' },
      { k:'us', parent:'root', text:'Target users' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'ft', parent:'root', text:'Features' },
      { k:'ft1',parent:'ft',   text:'Must-have' },
      { k:'ft2',parent:'ft',   text:'Nice-to-have' },
      { k:'me', parent:'root', text:'Success metrics' },
      { k:'ri', parent:'root', text:'Risks & open questions' }
    ]
  },
  okr: {
    name:'OKRs', desc:'Objectives & key results', color:'#3a6ea5', group:'product', icon:'🎯',
    nodes:[
      { k:'root', text:'Quarter / theme' },
      { k:'o1', parent:'root', text:'Objective 1' },
      { k:'o1a',parent:'o1',   text:'Key result 1' },
      { k:'o1b',parent:'o1',   text:'Key result 2' },
      { k:'o1c',parent:'o1',   text:'Initiatives' },
      { k:'o2', parent:'root', text:'Objective 2' },
      { k:'o2a',parent:'o2',   text:'Key result 1' },
      { k:'o2b',parent:'o2',   text:'Key result 2' }
    ]
  },
  persona: {
    name:'User persona', desc:'Who you are building for', color:'#8c5da7', group:'product', icon:'👤',
    nodes:[
      { k:'root', text:'Persona name' },
      { k:'bg', parent:'root', text:'Background' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'pa', parent:'root', text:'Pain points' },
      { k:'mo', parent:'root', text:'Motivations' },
      { k:'be', parent:'root', text:'Behaviors' },
      { k:'qu', parent:'root', text:'Favorite quote' }
    ]
  },
  gtm: {
    name:'Go-to-market plan', desc:'Launch & growth strategy', color:'#6a8c3f', group:'product', icon:'📣',
    nodes:[
      { k:'root', text:'Product launch' },
      { k:'ta', parent:'root', text:'Target market' },
      { k:'po', parent:'root', text:'Positioning' },
      { k:'pr', parent:'root', text:'Pricing' },
      { k:'ch', parent:'root', text:'Channels' },
      { k:'ms', parent:'root', text:'Messaging' },
      { k:'me', parent:'root', text:'Metrics' }
    ]
  },

  /* ===== Writers & creators ===== */
  novel: {
    name:'Novel / story plan', desc:'Premise, characters, plot, themes', color:'#b8451f', group:'writing', icon:'📕',
    nodes:[
      { k:'root', text:'Story title' },
      { k:'pr', parent:'root', text:'Premise' },
      { k:'ch', parent:'root', text:'Characters' },
      { k:'ch1',parent:'ch',   text:'Protagonist' },
      { k:'ch2',parent:'ch',   text:'Antagonist' },
      { k:'pl', parent:'root', text:'Plot arcs' },
      { k:'pl1',parent:'pl',   text:'Beginning' },
      { k:'pl2',parent:'pl',   text:'Middle' },
      { k:'pl3',parent:'pl',   text:'End' },
      { k:'se', parent:'root', text:'Setting' },
      { k:'th', parent:'root', text:'Themes' }
    ]
  },
  three_act: {
    name:'Three-act structure', desc:'Classic screenplay shape', color:'#c2783c', group:'writing', icon:'🎬',
    nodes:[
      { k:'root', text:'Story' },
      { k:'a1', parent:'root', text:'Act I - Setup' },
      { k:'a1a',parent:'a1',   text:'Inciting incident' },
      { k:'a1b',parent:'a1',   text:'Plot point 1' },
      { k:'a2', parent:'root', text:'Act II - Confrontation' },
      { k:'a2a',parent:'a2',   text:'Midpoint' },
      { k:'a2b',parent:'a2',   text:'Plot point 2' },
      { k:'a3', parent:'root', text:'Act III - Resolution' },
      { k:'a3a',parent:'a3',   text:'Climax' },
      { k:'a3b',parent:'a3',   text:'Denouement' }
    ]
  },
  article: {
    name:'Article / blog outline', desc:'Hook, sections, takeaways', color:'#2f6f6a', group:'writing', icon:'🖊',
    nodes:[
      { k:'root', text:'Article title' },
      { k:'ho', parent:'root', text:'Hook / intro' },
      { k:'s1', parent:'root', text:'Section 1' },
      { k:'s2', parent:'root', text:'Section 2' },
      { k:'s3', parent:'root', text:'Section 3' },
      { k:'ta', parent:'root', text:'Key takeaways' },
      { k:'cta',parent:'root', text:'Call to action' }
    ]
  },
  video_script: {
    name:'Video / podcast script', desc:'For YouTube & shows', color:'#8c5da7', group:'writing', icon:'🎙',
    nodes:[
      { k:'root', text:'Episode title' },
      { k:'ho', parent:'root', text:'Hook (first 10s)' },
      { k:'in', parent:'root', text:'Intro' },
      { k:'se', parent:'root', text:'Segments' },
      { k:'se1',parent:'se',   text:'Segment 1' },
      { k:'se2',parent:'se',   text:'Segment 2' },
      { k:'cta',parent:'root', text:'Call to action' },
      { k:'ou', parent:'root', text:'Outro' }
    ]
  },

  /* ===== Project management ===== */
  charter: {
    name:'Project charter', desc:'Scope, stakeholders, deliverables', color:'#2f6f6a', group:'pm', icon:'📜',
    nodes:[
      { k:'root', text:'Project name' },
      { k:'sc', parent:'root', text:'Scope' },
      { k:'ob', parent:'root', text:'Objectives' },
      { k:'st', parent:'root', text:'Stakeholders' },
      { k:'de', parent:'root', text:'Deliverables' },
      { k:'tl', parent:'root', text:'Timeline' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'ri', parent:'root', text:'Risks' }
    ]
  },
  wbs: {
    name:'Work breakdown structure', desc:'Phases → tasks → subtasks', color:'#3a6ea5', group:'pm', icon:'🗂',
    nodes:[
      { k:'root', text:'Project' },
      { k:'p1', parent:'root', text:'Phase 1' },
      { k:'p1a',parent:'p1',   text:'Task 1.1' },
      { k:'p1b',parent:'p1',   text:'Task 1.2' },
      { k:'p2', parent:'root', text:'Phase 2' },
      { k:'p2a',parent:'p2',   text:'Task 2.1' },
      { k:'p2b',parent:'p2',   text:'Task 2.2' },
      { k:'p3', parent:'root', text:'Phase 3' },
      { k:'p3a',parent:'p3',   text:'Task 3.1' }
    ]
  },
  swot: {
    name:'SWOT analysis', desc:'Strengths, weaknesses, etc.', color:'#c98a1a', group:'pm', icon:'⊞',
    nodes:[
      { k:'root', text:'Subject of analysis' },
      { k:'s', parent:'root', text:'Strengths' },
      { k:'w', parent:'root', text:'Weaknesses' },
      { k:'o', parent:'root', text:'Opportunities' },
      { k:'t', parent:'root', text:'Threats' }
    ]
  },
  meeting: {
    name:'Meeting agenda', desc:'Topics, decisions, actions', color:'#6a8c3f', group:'pm', icon:'👥',
    nodes:[
      { k:'root', text:'Meeting title' },
      { k:'ag', parent:'root', text:'Agenda' },
      { k:'ag1',parent:'ag',   text:'Topic 1' },
      { k:'ag2',parent:'ag',   text:'Topic 2' },
      { k:'de', parent:'root', text:'Decisions' },
      { k:'ai', parent:'root', text:'Action items' },
      { k:'fu', parent:'root', text:'Follow-ups' }
    ]
  },

  /* ===== Career & job search ===== */
  interview_prep: {
    name:'Interview prep', desc:'Research, stories, questions', color:'#c98a1a', group:'career', icon:'💬',
    nodes:[
      { k:'root', text:'Company / role' },
      { k:'re', parent:'root', text:'Company research' },
      { k:'st', parent:'root', text:'STAR stories' },
      { k:'st1',parent:'st',   text:'Leadership example' },
      { k:'st2',parent:'st',   text:'Conflict example' },
      { k:'st3',parent:'st',   text:'Failure & learning' },
      { k:'qa', parent:'root', text:'Questions to ask them' },
      { k:'ne', parent:'root', text:'Salary negotiation' }
    ]
  },
  resume: {
    name:'Résumé brainstorm', desc:'Surface your achievements', color:'#3a6ea5', group:'career', icon:'📄',
    nodes:[
      { k:'root', text:'Target role' },
      { k:'ex', parent:'root', text:'Experience' },
      { k:'ex1',parent:'ex',   text:'Achievement (with metric)' },
      { k:'sk', parent:'root', text:'Skills' },
      { k:'pr', parent:'root', text:'Projects' },
      { k:'ed', parent:'root', text:'Education' },
      { k:'ke', parent:'root', text:'Keywords from job post' }
    ]
  },
  career_decision: {
    name:'Career decision', desc:'Weigh options & priorities', color:'#8c5da7', group:'career', icon:'🧭',
    nodes:[
      { k:'root', text:'Decision' },
      { k:'o1', parent:'root', text:'Option A' },
      { k:'o1p',parent:'o1',   text:'Pros' },
      { k:'o1c',parent:'o1',   text:'Cons' },
      { k:'o2', parent:'root', text:'Option B' },
      { k:'o2p',parent:'o2',   text:'Pros' },
      { k:'o2c',parent:'o2',   text:'Cons' },
      { k:'va', parent:'root', text:'My priorities / values' }
    ]
  },

  /* ===== Design & UX ===== */
  design_brief: {
    name:'Design brief', desc:'Goals, audience, constraints', color:'#5b8db2', group:'design', icon:'🎨',
    nodes:[
      { k:'root', text:'Project' },
      { k:'go', parent:'root', text:'Goals' },
      { k:'au', parent:'root', text:'Audience' },
      { k:'br', parent:'root', text:'Brand / tone' },
      { k:'de', parent:'root', text:'Deliverables' },
      { k:'co', parent:'root', text:'Constraints' },
      { k:'in', parent:'root', text:'Inspiration' }
    ]
  },
  user_journey: {
    name:'User journey map', desc:'Stages, actions, emotions', color:'#6a8c3f', group:'design', icon:'🚶',
    nodes:[
      { k:'root', text:'Journey: [persona + goal]' },
      { k:'s1', parent:'root', text:'Awareness' },
      { k:'s1a',parent:'s1',   text:'Actions / emotions' },
      { k:'s2', parent:'root', text:'Consideration' },
      { k:'s2a',parent:'s2',   text:'Actions / emotions' },
      { k:'s3', parent:'root', text:'Decision' },
      { k:'s3a',parent:'s3',   text:'Actions / emotions' },
      { k:'s4', parent:'root', text:'Retention' },
      { k:'pa', parent:'root', text:'Pain points' }
    ]
  },
  usability_test: {
    name:'Usability test plan', desc:'Tasks, metrics, participants', color:'#c2783c', group:'design', icon:'🔬',
    nodes:[
      { k:'root', text:'Test plan' },
      { k:'go', parent:'root', text:'Research goals' },
      { k:'pa', parent:'root', text:'Participants' },
      { k:'ta', parent:'root', text:'Tasks' },
      { k:'ta1',parent:'ta',   text:'Task 1' },
      { k:'ta2',parent:'ta',   text:'Task 2' },
      { k:'me', parent:'root', text:'Metrics' },
      { k:'qu', parent:'root', text:'Post-test questions' }
    ]
  },

  /* ===== Event & personal ===== */
  personal_hub: {
    name:'Personal dashboard', desc:'Journal, to-dos, habits, goals - your life in one map', color:'#8c5da7', group:'personal', icon:'🌱',
    nodes:[
      { k:'root', text:'My life' },
      { k:'jr',  parent:'root', text:'Journal' },
      { k:'jr1', parent:'jr',   text:'Today - [date]' },
      { k:'jr2', parent:'jr',   text:'Grateful for…' },
      { k:'jr3', parent:'jr',   text:'On my mind…' },
      { k:'td',  parent:'root', text:'To-do' },
      { k:'td1', parent:'td',   text:'Today', task:'todo' },
      { k:'td2', parent:'td',   text:'This week', task:'todo' },
      { k:'td3', parent:'td',   text:'Someday / maybe' },
      { k:'hb',  parent:'root', text:'Habits' },
      { k:'hb1', parent:'hb',   text:'Daily - [e.g. read 20 min]', task:'todo' },
      { k:'hb2', parent:'hb',   text:'Weekly - [e.g. exercise 3×]', task:'todo' },
      { k:'go',  parent:'root', text:'Goals' },
      { k:'go1', parent:'go',   text:'This month' },
      { k:'go2', parent:'go',   text:'This year' },
      { k:'id',  parent:'root', text:'Ideas & notes' },
      { k:'id1', parent:'id',   text:'[capture anything here]' },
      { k:'rv',  parent:'root', text:'Weekly review' },
      { k:'rv1', parent:'rv',   text:'What went well?' },
      { k:'rv2', parent:'rv',   text:'What to improve?' },
      { k:'rv3', parent:'rv',   text:'Focus for next week' }
    ]
  },
  event: {
    name:'Event planning', desc:'Venue, guests, schedule, budget', color:'#6a8c3f', group:'personal', icon:'🎉',
    nodes:[
      { k:'root', text:'Event name' },
      { k:'ve', parent:'root', text:'Venue' },
      { k:'gu', parent:'root', text:'Guests' },
      { k:'ca', parent:'root', text:'Catering' },
      { k:'sc', parent:'root', text:'Schedule' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'su', parent:'root', text:'Suppliers' },
      { k:'ch', parent:'root', text:'Checklist' }
    ]
  },
  trip: {
    name:'Trip planner', desc:'Destinations, logistics, budget', color:'#5b8db2', group:'personal', icon:'✈',
    nodes:[
      { k:'root', text:'Trip' },
      { k:'de', parent:'root', text:'Destinations' },
      { k:'da', parent:'root', text:'Dates' },
      { k:'tr', parent:'root', text:'Transport' },
      { k:'st', parent:'root', text:'Stay' },
      { k:'ac', parent:'root', text:'Activities' },
      { k:'bu', parent:'root', text:'Budget' },
      { k:'pa', parent:'root', text:'Packing list' }
    ]
  },
  decision_matrix: {
    name:'Decision matrix', desc:'Pros / cons / criteria', color:'#c98a1a', group:'personal', icon:'⚖',
    nodes:[
      { k:'root', text:'Decision' },
      { k:'cr', parent:'root', text:'Criteria' },
      { k:'o1', parent:'root', text:'Option A' },
      { k:'o1p',parent:'o1',   text:'Pros' },
      { k:'o1c',parent:'o1',   text:'Cons' },
      { k:'o2', parent:'root', text:'Option B' },
      { k:'o2p',parent:'o2',   text:'Pros' },
      { k:'o2c',parent:'o2',   text:'Cons' }
    ]
  },
  weekly_goals: {
    name:'Weekly goals', desc:'Plan your week by area', color:'#6a8c3f', group:'personal', icon:'🗓',
    nodes:[
      { k:'root', text:'This week' },
      { k:'wo', parent:'root', text:'Work' },
      { k:'he', parent:'root', text:'Health' },
      { k:'le', parent:'root', text:'Learning' },
      { k:'pe', parent:'root', text:'Personal' },
      { k:'pr', parent:'root', text:'Top 3 priorities' }
    ]
  },

  /* ===== Professional (use as documentation scaffolds) ===== */
  case_brief: {
    name:'Legal case brief', desc:'Facts, issue, rule, analysis', color:'#8c5da7', group:'pro', icon:'⚖',
    nodes:[
      { k:'root', text:'Case name & citation' },
      { k:'fa', parent:'root', text:'Facts' },
      { k:'is', parent:'root', text:'Issue' },
      { k:'ru', parent:'root', text:'Rule of law' },
      { k:'an', parent:'root', text:'Analysis / reasoning' },
      { k:'ho', parent:'root', text:'Holding' },
      { k:'di', parent:'root', text:'Dissent / notes' }
    ]
  },
  soap_note: {
    name:'SOAP note (clinical)', desc:'Documentation scaffold only', color:'#2f6f6a', group:'pro', icon:'🩺',
    nodes:[
      { k:'root', text:'Encounter' },
      { k:'s', parent:'root', text:'Subjective' },
      { k:'o', parent:'root', text:'Objective' },
      { k:'a', parent:'root', text:'Assessment' },
      { k:'p', parent:'root', text:'Plan' }
    ]
  },

  /* ===== Feature showcase - demonstrates colours, formatting, notes, tasks,
     markers, an image and cross-links. A friendly first map to explore. ===== */
  showcase: {
    name:'Feature showcase', desc:'Markers, tasks, notes, links & formatting', color:'#e0613a', group:'pro', icon:'✨',
    nodes:[
      { k:'root', text:'MindSpark tour', notes:'<p>This map shows off a few things MindSpark can do \u2014 try clicking the ⭐ badges, the ☑ task boxes, or a node to see its toolbar.</p>' },
      { k:'mk', parent:'root', text:'Markers & priorities', marker:'\u2B50', fontSize:16, bold:true, color:'#ffedc2' },
      { k:'m1', parent:'mk', text:'Must ship this week', marker:'\u2757', task:'doing' },
      { k:'m2', parent:'mk', text:'Blocked - needs review', marker:'\u{1F512}', task:'todo' },
      { k:'m3', parent:'mk', text:'Fresh idea', marker:'\u{1F4A1}', task:'todo' },
      { k:'ts', parent:'root', text:'Tasks & progress', fontSize:16, bold:true, color:'#dcefce' },
      { k:'t1', parent:'ts', text:'Todo item', task:'todo' },
      { k:'t2', parent:'ts', text:'In progress', task:'doing' },
      { k:'t3', parent:'ts', text:'Done - strikethrough', task:'done' },
      { k:'nt', parent:'root', text:'Notes on any node', notes:'<p>Click the 📝 button in the node toolbar (or press <kbd>Shift</kbd>+<kbd>Enter</kbd> on a node) to open this sticky note.</p>' },
      { k:'lk', parent:'root', text:'Cross-links', fontSize:16, bold:true, color:'#d8e0fb' },
      { k:'l1', parent:'lk', text:'Marker section' },
      { k:'l2', parent:'lk', text:'Tasks section' },
      { k:'ex', parent:'root', text:'Markdown pane', notes:'<p>Open the 📄 button to edit this map as Markdown and export it to PDF.</p>' }
    ],
    links:[ { from:'l1', to:'mk' }, { from:'l2', to:'ts' } ]
  },
};
// Template categories (ordered) for the drill-down menu.
const TEMPLATE_CATEGORIES = [
  { id:'prompt',   label:'Prompt engineering',  icon:'✦', color:'#5b8db2' },
  { id:'ai',       label:'AI & agents',          icon:'🤖', color:'#8c5da7' },
  { id:'research', label:'Research & writing',   icon:'🔬', color:'#3a6ea5' },
  { id:'study',    label:'Students & educators', icon:'🎓', color:'#6a8c3f' },
  { id:'software', label:'Software & technical', icon:'💻', color:'#8c5da7' },
  { id:'product',  label:'Product & founders',   icon:'🚀', color:'#c2783c' },
  { id:'writing',  label:'Writers & creators',   icon:'✒', color:'#b8451f' },
  { id:'pm',       label:'Project management',   icon:'📋', color:'#2f6f6a' },
  { id:'career',   label:'Career & job search',  icon:'💼', color:'#c98a1a' },
  { id:'design',   label:'Design & UX',          icon:'🎨', color:'#5b8db2' },
  { id:'personal', label:'Event & personal',     icon:'🗓', color:'#6a8c3f' },
  { id:'pro',      label:'Professional',         icon:'⚖', color:'#8c5da7' }
];

// Seed a new map from a template. Mirrors createMap()'s lifecycle but uses
// the template's pre-built node graph instead of an empty root.
