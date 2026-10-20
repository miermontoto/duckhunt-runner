// aws cli en lectura (t#385, daemon con capability read_shell): lo que el server compone como
// `Bash(aws <servicio> <operación>*)` en un run de lectura y lo que el daemon acepta de esos patrones.

// identidad aws por defecto de la máquina (t#495, M5): una clave que el usuario expone a mano en el daemon (`resource
// add aws default`), nunca implícita. el daemon la anuncia (LegacyClaimAwsDefault en el cable legacy, una clave más de
// `aws` en los resources[] de v0) y el toolset_v1 la concede a un run SIN cuenta: read en uno de lectura con la aws en
// lectura, full en uno con Bash entero. una cuenta del run que la máquina no anuncia no cae en ella (aws_strict).
export const RUNNER_AWS_DEFAULT_KEY = 'default';

// read quita el deny de Bash entero y permite SOLO `aws <servicio> <verbo de lectura>*`. verificado
// con el cli 2.1.282: un patrón fijado en servicio + operación aguanta `;` `&&` `&` `$()` `<()`,
// redirecciones, pipes a comandos no aprobados y `VAR=… aws`. un comodín ANTES de la operación NO
// (`aws * list-*` casó `aws s3 rm s3://b --recursive --exclude list-x`): por eso los servicios van
// enumerados. sin el deny de Bash, el clasificador del cli auto-aprueba además sus comandos de solo
// lectura en el cwd (cat, grep, jq, git log|diff|status) y bloqueó los 16 vectores de ejecución o
// escritura probados (npm run, git -c core.pager, rg --pre, awk system(), sort -o, find -exec…).
// los nombres de servicio son los de la cli (s3api, configservice, deploy), no los de botocore.
export const AGENT_AWS_READ_SERVICES = [
  'acm', 'apigateway', 'apigatewayv2', 'application-autoscaling', 'apprunner', 'appsync', 'athena',
  'autoscaling', 'backup', 'batch', 'budgets', 'ce', 'cloudformation', 'cloudfront', 'cloudtrail',
  'cloudwatch', 'codebuild', 'codepipeline', 'cognito-idp', 'compute-optimizer', 'configservice',
  'deploy', 'docdb', 'dynamodb', 'ec2', 'ecr', 'ecs', 'efs', 'eks', 'elasticache', 'elasticbeanstalk',
  'elb', 'elbv2', 'es', 'events', 'firehose', 'glue', 'guardduty', 'health', 'iam', 'inspector2',
  'kafka', 'kinesis', 'kms', 'lambda', 'logs', 'memorydb', 'mq', 'neptune', 'opensearch',
  'organizations', 'pipes', 'pricing', 'rds', 'redshift', 'resourcegroupstaggingapi', 'route53',
  's3api', 'scheduler', 'secretsmanager', 'securityhub', 'service-quotas', 'ses', 'sesv2', 'sns',
  'sqs', 'ssm', 'stepfunctions', 'transfer', 'wafv2', 'xray',
] as const;
// verbos de lectura por convención de la api de aws. el daemon acepta solo estos (ampliarlos exige
// daemon nuevo: descarta lo que no reconoce).
export const AGENT_AWS_READ_VERBS = ['describe-', 'list-', 'get-', 'batch-get-'] as const;
// lecturas que no siguen la convención: servicio + operación exacta (misma lista en el daemon).
export const AGENT_AWS_READ_COMMANDS = [
  'logs filter-log-events',
  'logs tail',
  'logs start-query',
  's3 ls',
  's3api head-object',
  's3api head-bucket',
  'cloudtrail lookup-events',
  'dynamodb query',
  'dynamodb scan',
  'rds download-db-log-file-portion',
  'sts get-caller-identity',
  'sts get-access-key-info',
] as const;
// lecturas que se niegan aunque casen con un verbo (deny gana a allow), por PREFIJO de operación:
// nunca por flag, la aws cli acepta abreviaturas (`--with-d` = `--with-decryption`) y
// --cli-input-json. secret stores y credenciales (entregan secretos, no estado) + escritores de
// fichero local (payload blob → la cli exige un outfile). ssm get-parameter cubre get-parameters,
// -by-path e -history; s3api get-object cubre get-object-torrent (y de paso sus subrecursos).
export const AGENT_AWS_READ_DENIED_COMMANDS = [
  'secretsmanager get-secret-value',
  'secretsmanager batch-get-secret-value',
  'ssm get-parameter',
  'ecr get-login-password',
  'ecr get-authorization-token',
  'eks get-token',
  'redshift get-cluster-credentials',
  'ec2 get-password-data',
  'cognito-idp describe-user-pool-client',
  'apigateway get-api-key',
  'appsync list-api-keys',
  'glue get-connection',
  's3api get-object',
  'apigateway get-export',
  'apigateway get-sdk',
  'appsync get-introspection-schema',
  'cloudfront get-function',
] as const;
