{{- define "genchi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "genchi.migrationEnvironment" -}}
- name: GENCHI_ENVIRONMENT
  value: {{ .Values.runtime.environment | quote }}
- name: GENCHI_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.databaseUrl | quote }}
- name: GENCHI_REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.redisUrl | quote }}
- name: GENCHI_KEY_HASH_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.keyHashPepper | quote }}
- name: GENCHI_LOG_LEVEL
  value: {{ .Values.runtime.logLevel | quote }}
{{- if .Values.runtime.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.runtime.otlpEndpoint | quote }}
{{- end }}
{{- end }}

{{- define "genchi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "genchi.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "genchi.labels" -}}
app.kubernetes.io/name: {{ include "genchi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "genchi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "genchi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "genchi.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "genchi.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when create=false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "genchi.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s:%s@%s" .Values.image.repository .Values.image.tag .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}
{{- end }}

{{- define "genchi.environment" -}}
- name: GENCHI_ENVIRONMENT
  value: {{ .Values.runtime.environment | quote }}
- name: GENCHI_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.databaseUrl | quote }}
- name: GENCHI_REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.redisUrl | quote }}
- name: GENCHI_KEY_HASH_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.keyHashPepper | quote }}
{{- if .Values.secretKeys.masterKey }}
- name: GENCHI_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.masterKey | quote }}
{{- end }}
{{- if .Values.secretKeys.openaiApiKey }}
- name: OPENAI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.openaiApiKey | quote }}
{{- end }}
{{- if .Values.secretKeys.anthropicApiKey }}
- name: ANTHROPIC_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.anthropicApiKey | quote }}
{{- end }}
{{- if .Values.secretKeys.geminiApiKey }}
- name: GEMINI_API_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.geminiApiKey | quote }}
{{- end }}
- name: GENCHI_CONFIG_FILE
  value: /etc/genchi/config.yaml
- name: GENCHI_HOST
  value: 0.0.0.0
- name: GENCHI_PORT
  value: "8080"
- name: GENCHI_LOG_LEVEL
  value: {{ .Values.runtime.logLevel | quote }}
- name: GENCHI_REQUEST_BODY_LIMIT_BYTES
  value: {{ .Values.runtime.requestBodyLimitBytes | quote }}
- name: GENCHI_TOTAL_TIMEOUT_MS
  value: {{ .Values.runtime.totalTimeoutMs | quote }}
- name: GENCHI_CONNECT_TIMEOUT_MS
  value: {{ .Values.runtime.connectTimeoutMs | quote }}
- name: GENCHI_SHUTDOWN_GRACE_MS
  value: {{ .Values.runtime.shutdownGraceMs | quote }}
- name: AUTH_CACHE_TTL_SECONDS
  value: {{ .Values.runtime.authCacheTtlSeconds | quote }}
- name: CONFIG_CACHE_TTL_SECONDS
  value: {{ .Values.runtime.configCacheTtlSeconds | quote }}
- name: GENCHI_TRUST_PROXY
  value: {{ .Values.runtime.trustProxy | quote }}
- name: GENCHI_METRICS_ENABLED
  value: {{ .Values.runtime.metricsEnabled | quote }}
{{- if .Values.runtime.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.runtime.otlpEndpoint | quote }}
{{- end }}
{{- end }}
