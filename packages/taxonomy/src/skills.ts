import { TermMatcher } from './text';
import type { TermEntry, TermMatch } from './text';

/**
 * Small normalised skills dictionary (languages, frameworks, clouds, databases, practices).
 * Concepts are stable snake-case identifiers; aliases cover common spellings ("k8s", "golang",
 * "postgres"). Short or word-like aliases ("Go", "React", "Spring", "TS") are case-sensitive.
 */

export const SKILL_CATEGORIES = [
  'language',
  'frontend',
  'backend',
  'mobile',
  'data',
  'database',
  'cloud',
  'devops',
  'ml',
  'testing',
  'practice',
  'design',
  'security',
  'business_tool',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface SkillDef {
  concept: string;
  label: string;
  category: SkillCategory;
  /** Case-insensitive aliases (the label is always included). */
  aliases?: readonly string[];
  /** Case-sensitive aliases. */
  cs?: readonly string[];
  /** When true the label itself is matched case-sensitively. */
  labelCaseSensitive?: boolean;
}

function s(
  concept: string,
  label: string,
  category: SkillCategory,
  aliases: string[] = [],
  cs: string[] = [],
  labelCaseSensitive = false,
): SkillDef {
  return { concept, label, category, aliases, cs, labelCaseSensitive };
}

export const SKILLS: readonly SkillDef[] = [
  // Languages
  s('javascript', 'JavaScript', 'language', ['ecmascript', 'es6', 'vanilla js'], ['JS']),
  s('typescript', 'TypeScript', 'language', [], ['TS']),
  s('python', 'Python', 'language', ['python3']),
  s('java', 'Java', 'language', [], [], true),
  s('kotlin', 'Kotlin', 'language'),
  s('scala', 'Scala', 'language'),
  s('go', 'Go', 'language', ['golang'], ['Go'], true),
  s('rust', 'Rust', 'language', [], [], true),
  s('c', 'C', 'language', ['ansi c'], ['C'], true),
  s('cpp', 'C++', 'language', ['cpp', 'c plus plus']),
  s('csharp', 'C#', 'language', ['c sharp', 'csharp']),
  s('ruby', 'Ruby', 'language', [], [], true),
  s('php', 'PHP', 'language', [], ['PHP'], true),
  s('swift', 'Swift', 'language', [], ['Swift'], true),
  s('objective_c', 'Objective-C', 'language', ['objc', 'obj-c']),
  s('dart', 'Dart', 'language', [], ['Dart'], true),
  s('elixir', 'Elixir', 'language'),
  s('erlang', 'Erlang', 'language'),
  s('haskell', 'Haskell', 'language'),
  s('clojure', 'Clojure', 'language'),
  s('r', 'R', 'language', [], ['R'], true),
  s('sql', 'SQL', 'language', ['t-sql', 'pl/sql', 'plsql'], ['SQL'], true),
  s('bash', 'Bash', 'language', ['shell scripting', 'shell script', 'zsh']),
  s('powershell', 'PowerShell', 'language'),
  s('html', 'HTML', 'frontend', ['html5']),
  s('css', 'CSS', 'frontend', ['css3']),
  s('sass', 'Sass', 'frontend', ['scss'], ['Sass'], true),
  s('solidity', 'Solidity', 'language'),
  // Frontend frameworks
  s('react', 'React', 'frontend', ['react.js', 'reactjs', 'react js'], ['React'], true),
  s('react_native', 'React Native', 'mobile'),
  s('nextjs', 'Next.js', 'frontend', ['nextjs', 'next js']),
  s('vue', 'Vue', 'frontend', ['vue.js', 'vuejs', 'vue 3'], ['Vue'], true),
  s('nuxt', 'Nuxt', 'frontend', ['nuxt.js', 'nuxtjs']),
  s('angular', 'Angular', 'frontend', ['angularjs', 'angular.js'], ['Angular'], true),
  s('svelte', 'Svelte', 'frontend', ['sveltekit']),
  s('redux', 'Redux', 'frontend'),
  s('tailwind', 'Tailwind CSS', 'frontend', ['tailwind', 'tailwindcss']),
  s('webpack', 'Webpack', 'frontend'),
  s('vite', 'Vite', 'frontend', [], ['Vite'], true),
  // Backend frameworks & runtimes
  s('nodejs', 'Node.js', 'backend', ['nodejs', 'node js'], ['Node']),
  s('express', 'Express', 'backend', ['express.js', 'expressjs'], ['Express'], true),
  s('nestjs', 'NestJS', 'backend', ['nest.js']),
  s('django', 'Django', 'backend'),
  s('flask', 'Flask', 'backend', [], ['Flask'], true),
  s('fastapi', 'FastAPI', 'backend'),
  s('rails', 'Ruby on Rails', 'backend', ['rails', 'ror']),
  s('spring', 'Spring Boot', 'backend', ['spring framework', 'springboot'], ['Spring']),
  s('dotnet', '.NET', 'backend', ['dotnet', '.net core', 'asp.net', 'asp.net core']),
  s('laravel', 'Laravel', 'backend'),
  s('symfony', 'Symfony', 'backend'),
  s('graphql', 'GraphQL', 'backend'),
  s('rest_api', 'REST APIs', 'backend', ['restful', 'rest api', 'rest apis', 'restful apis'], ['REST']),
  s('grpc', 'gRPC', 'backend'),
  s('microservices', 'Microservices', 'backend', [
    'microservice',
    'micro-services',
    'service-oriented architecture',
    'soa',
  ]),
  s('distributed_systems', 'Distributed systems', 'backend', ['distributed system', 'distributed computing']),
  s('event_driven', 'Event-driven architecture', 'backend', [
    'event-driven',
    'event driven',
    'event sourcing',
  ]),
  s('kafka', 'Kafka', 'data', ['apache kafka', 'kafka streams']),
  s('rabbitmq', 'RabbitMQ', 'backend'),
  s('serverless', 'Serverless', 'cloud', ['aws lambda', 'lambda functions', 'cloud functions']),
  // Mobile
  s('ios', 'iOS', 'mobile'),
  s('android', 'Android', 'mobile'),
  s('swiftui', 'SwiftUI', 'mobile'),
  s('flutter', 'Flutter', 'mobile'),
  s('jetpack_compose', 'Jetpack Compose', 'mobile'),
  // Databases
  s('postgresql', 'PostgreSQL', 'database', ['postgres', 'postgresql', 'psql']),
  s('mysql', 'MySQL', 'database', ['mariadb']),
  s('sql_server', 'SQL Server', 'database', ['mssql', 'ms sql', 'microsoft sql server']),
  s('oracle_db', 'Oracle Database', 'database', ['oracle db', 'pl sql'], ['Oracle']),
  s('sqlite', 'SQLite', 'database'),
  s('mongodb', 'MongoDB', 'database', ['mongo', 'mongo db']),
  s('redis', 'Redis', 'database'),
  s('dynamodb', 'DynamoDB', 'database', ['dynamo db']),
  s('cassandra', 'Cassandra', 'database', ['apache cassandra']),
  s('elasticsearch', 'Elasticsearch', 'database', ['elastic search', 'elk stack', 'elk']),
  s('opensearch', 'OpenSearch', 'database'),
  s('neo4j', 'Neo4j', 'database'),
  s('clickhouse', 'ClickHouse', 'database'),
  s('nosql', 'NoSQL', 'database'),
  // Data
  s('snowflake', 'Snowflake', 'data', [], ['Snowflake'], true),
  s('bigquery', 'BigQuery', 'data', ['big query']),
  s('redshift', 'Redshift', 'data', ['amazon redshift']),
  s('databricks', 'Databricks', 'data'),
  s('spark', 'Apache Spark', 'data', ['pyspark', 'spark sql'], ['Spark']),
  s('hadoop', 'Hadoop', 'data', ['hdfs']),
  s('airflow', 'Airflow', 'data', ['apache airflow']),
  s('dbt', 'dbt', 'data', ['data build tool'], ['dbt', 'DBT'], true),
  s('flink', 'Flink', 'data', ['apache flink']),
  s('etl', 'ETL', 'data', ['elt', 'etl pipelines', 'data pipelines', 'data pipeline']),
  s('data_modeling', 'Data modelling', 'data', [
    'data modeling',
    'dimensional modeling',
    'dimensional modelling',
  ]),
  s('pandas', 'pandas', 'data'),
  s('numpy', 'NumPy', 'data'),
  s('tableau', 'Tableau', 'data'),
  s('power_bi', 'Power BI', 'data', ['powerbi']),
  s('looker', 'Looker', 'data'),
  s('excel', 'Excel', 'business_tool', ['microsoft excel', 'ms excel', 'spreadsheets'], [], true),
  s('statistics', 'Statistics', 'data', [
    'statistical analysis',
    'statistical modelling',
    'statistical modeling',
  ]),
  s('ab_testing', 'A/B testing', 'data', ['a/b testing', 'ab testing', 'experimentation']),
  // ML
  s('machine_learning', 'Machine learning', 'ml', ['machine-learning'], ['ML']),
  s('deep_learning', 'Deep learning', 'ml'),
  s('pytorch', 'PyTorch', 'ml'),
  s('tensorflow', 'TensorFlow', 'ml', ['keras']),
  s('scikit_learn', 'scikit-learn', 'ml', ['sklearn', 'scikit learn']),
  s('nlp', 'NLP', 'ml', ['natural language processing']),
  s('computer_vision', 'Computer vision', 'ml'),
  s('llm', 'LLMs', 'ml', ['llm', 'large language models', 'large language model', 'generative ai', 'genai']),
  s('rag', 'Retrieval-augmented generation', 'ml', ['retrieval augmented generation'], ['RAG']),
  s('langchain', 'LangChain', 'ml'),
  s('hugging_face', 'Hugging Face', 'ml', ['huggingface', 'transformers library']),
  s('mlops', 'MLOps', 'ml', ['ml ops']),
  s('jupyter', 'Jupyter', 'ml', ['jupyter notebooks']),
  // Cloud & DevOps
  s('aws', 'AWS', 'cloud', ['amazon web services']),
  s('gcp', 'GCP', 'cloud', ['google cloud', 'google cloud platform']),
  s('azure', 'Azure', 'cloud', ['microsoft azure']),
  s('kubernetes', 'Kubernetes', 'devops', ['k8s', 'kube', 'eks', 'gke', 'aks']),
  s('docker', 'Docker', 'devops', ['containers', 'containerization', 'containerisation']),
  s('terraform', 'Terraform', 'devops'),
  s('pulumi', 'Pulumi', 'devops'),
  s('cloudformation', 'CloudFormation', 'devops'),
  s('ansible', 'Ansible', 'devops'),
  s('helm', 'Helm', 'devops', [], ['Helm'], true),
  s('istio', 'Istio', 'devops', ['service mesh']),
  s('linux', 'Linux', 'devops', ['unix']),
  s('nginx', 'Nginx', 'devops'),
  s('git', 'Git', 'devops', ['github', 'gitlab', 'bitbucket'], ['Git']),
  s('ci_cd', 'CI/CD', 'devops', [
    'ci/cd',
    'ci / cd',
    'continuous integration',
    'continuous delivery',
    'continuous deployment',
    'cicd',
  ]),
  s('github_actions', 'GitHub Actions', 'devops'),
  s('jenkins', 'Jenkins', 'devops'),
  s('circleci', 'CircleCI', 'devops'),
  s('argocd', 'Argo CD', 'devops', ['argocd']),
  s('prometheus', 'Prometheus', 'devops'),
  s('grafana', 'Grafana', 'devops'),
  s('datadog', 'Datadog', 'devops'),
  s('opentelemetry', 'OpenTelemetry', 'devops', ['otel']),
  s('observability', 'Observability', 'devops', ['monitoring and alerting']),
  s('infrastructure_as_code', 'Infrastructure as code', 'devops', ['infrastructure-as-code'], ['IaC']),
  s('devops', 'DevOps', 'practice'),
  s('sre', 'Site reliability engineering', 'practice', ['site reliability'], ['SRE']),
  s('firebase', 'Firebase', 'cloud'),
  // Testing
  s('jest', 'Jest', 'testing', [], ['Jest'], true),
  s('cypress', 'Cypress', 'testing'),
  s('playwright', 'Playwright', 'testing'),
  s('selenium', 'Selenium', 'testing'),
  s('unit_testing', 'Unit testing', 'testing', ['unit tests', 'automated testing', 'test automation']),
  s(
    'tdd',
    'Test-driven development',
    'practice',
    ['test-driven development', 'test driven development'],
    ['TDD'],
  ),
  // Practices
  s('agile', 'Agile', 'practice', ['scrum', 'kanban']),
  s('system_design', 'System design', 'practice', [
    'systems design',
    'software architecture',
    'system architecture',
  ]),
  s('api_design', 'API design', 'practice'),
  s('performance_optimization', 'Performance optimisation', 'practice', [
    'performance optimization',
    'performance tuning',
  ]),
  // Design
  s('figma', 'Figma', 'design'),
  s('sketch', 'Sketch', 'design', [], ['Sketch'], true),
  s('adobe_creative_suite', 'Adobe Creative Suite', 'design', [
    'adobe creative cloud',
    'photoshop',
    'illustrator',
  ]),
  s('user_research', 'User research', 'design', ['ux research', 'usability testing']),
  s('prototyping', 'Prototyping', 'design'),
  s('design_systems', 'Design systems', 'design', ['design system']),
  s('accessibility', 'Accessibility', 'design', ['a11y', 'wcag']),
  s('seo', 'SEO', 'business_tool', ['search engine optimisation', 'search engine optimization']),
  // Security
  s('penetration_testing', 'Penetration testing', 'security', ['pen testing', 'pentesting']),
  s('siem', 'SIEM', 'security'),
  s('iso_27001', 'ISO 27001', 'security', ['iso27001']),
  s('soc2', 'SOC 2', 'security', ['soc2', 'soc 2 type ii']),
  s('gdpr', 'GDPR', 'security'),
  s('oauth', 'OAuth', 'security', ['oauth2', 'oauth 2.0', 'openid connect', 'oidc']),
  s('blockchain', 'Blockchain', 'backend', ['web3', 'smart contracts']),
  // Business tools
  s('salesforce', 'Salesforce', 'business_tool'),
  s('hubspot', 'HubSpot', 'business_tool'),
  s('jira', 'Jira', 'business_tool'),
  s('sap', 'SAP', 'business_tool', [], ['SAP'], true),
  s('unity', 'Unity', 'backend', ['unity3d'], ['Unity'], true),
  s('unreal_engine', 'Unreal Engine', 'backend', ['unreal', 'ue5']),
];

const BY_CONCEPT = new Map(SKILLS.map((sk) => [sk.concept, sk]));

const entries: Array<TermEntry<string>> = SKILLS.flatMap((sk) => [
  { term: sk.label, value: sk.concept, caseSensitive: sk.labelCaseSensitive ?? false },
  ...(sk.aliases ?? []).map((a) => ({ term: a, value: sk.concept })),
  ...(sk.cs ?? []).map((a) => ({ term: a, value: sk.concept, caseSensitive: true })),
]);

/** Context guards for aliases that are also ordinary words or prefixes (C-level, R&D, Go-to-market). */
function rejectSkill(text: string, m: TermMatch<string>): boolean {
  const after = text.slice(m.index + m.matchedText.length, m.index + m.matchedText.length + 12);
  const before = text.slice(Math.max(0, m.index - 1), m.index);
  if (/^[+#]/.test(after)) return true; // "C" inside "C++"/"C#" spelled with spaces
  if (before === '.' || before === '-' || before === '/') {
    // "ASP.NET" handled by its own alias; ".js" suffixes, "co-Go" etc. are not standalone skills
    if (m.matchedText.length <= 2) return true;
  }
  if (m.value === 'c' || m.value === 'r') {
    if (/^(?:-|&|'|\.\w)/.test(after)) return true; // C-level, C-suite, R&D
    if (/^\s*(?:level|suite)\b/i.test(after)) return true;
  }
  if (m.value === 'go' && /^(?:-to|\s+to\b|\s+live|\s+above|\s+beyond|-live)/i.test(after)) return true;
  if (m.value === 'c' || m.value === 'r') {
    const lead = text.slice(Math.max(0, m.index - 12), m.index);
    if (/(?:series|plan|type|grade|class|section|option|level|vitamin)\s$/i.test(lead)) return true;
  }
  if (m.value === 'typescript' && /^\/SCI/i.test(after)) return true; // TS/SCI clearance
  return false;
}

const skillMatcher = new TermMatcher<string>(entries, rejectSkill);

export interface SkillMatch {
  concept: string;
  matchedText: string;
  index: number;
}

/** Normalised skill concepts mentioned in text, in order of appearance. */
export function findSkills(text: string): SkillMatch[] {
  return skillMatcher
    .find(text)
    .map((m) => ({ concept: m.value, matchedText: m.matchedText, index: m.index }));
}

/** Normalises a single skill term ("k8s" → "kubernetes", "React.js" → "react"); null when unknown. */
export function normalizeSkill(term: string): string | null {
  return skillMatcher.lookup(term) ?? null;
}

export function getSkill(concept: string): SkillDef | undefined {
  return BY_CONCEPT.get(concept);
}
