{{- define "rax-compute-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "rax-compute-gateway.migrationEnvironment" -}}
- name: RCG_ENVIRONMENT
  value: {{ .Values.runtime.environment | quote }}
- name: RCG_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.databaseUrl | quote }}
- name: RCG_REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.redisUrl | quote }}
- name: RCG_KEY_HASH_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.keyHashPepper | quote }}
- name: RCG_LOG_LEVEL
  value: {{ .Values.runtime.logLevel | quote }}
{{- if .Values.runtime.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.runtime.otlpEndpoint | quote }}
{{- end }}
{{- end }}

{{- define "rax-compute-gateway.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "rax-compute-gateway.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "rax-compute-gateway.labels" -}}
app.kubernetes.io/name: {{ include "rax-compute-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end }}

{{- define "rax-compute-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rax-compute-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "rax-compute-gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "rax-compute-gateway.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when create=false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "rax-compute-gateway.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s:%s@%s" .Values.image.repository .Values.image.tag .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag }}
{{- end }}
{{- end }}

{{- define "rax-compute-gateway.environment" -}}
- name: RCG_ENVIRONMENT
  value: {{ .Values.runtime.environment | quote }}
- name: RCG_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.databaseUrl | quote }}
- name: RCG_REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.redisUrl | quote }}
- name: RCG_KEY_HASH_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ .Values.secretKeys.keyHashPepper | quote }}
{{- if .Values.secretKeys.masterKey }}
- name: RCG_MASTER_KEY
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
- name: RCG_CONFIG_FILE
  value: /etc/rax-compute-gateway/config.yaml
- name: RCG_HOST
  value: 0.0.0.0
- name: RCG_PORT
  value: "8080"
- name: RCG_LOG_LEVEL
  value: {{ .Values.runtime.logLevel | quote }}
- name: RCG_REQUEST_BODY_LIMIT_BYTES
  value: {{ .Values.runtime.requestBodyLimitBytes | quote }}
- name: RCG_TOTAL_TIMEOUT_MS
  value: {{ .Values.runtime.totalTimeoutMs | quote }}
- name: RCG_CONNECT_TIMEOUT_MS
  value: {{ .Values.runtime.connectTimeoutMs | quote }}
- name: RCG_SHUTDOWN_GRACE_MS
  value: {{ .Values.runtime.shutdownGraceMs | quote }}
- name: RCG_TRUST_PROXY
  value: {{ .Values.runtime.trustProxy | quote }}
- name: RCG_METRICS_ENABLED
  value: {{ .Values.runtime.metricsEnabled | quote }}
{{- if .Values.admin.enabled }}
- name: RCG_ADMIN_ENABLED
  value: "true"
- name: RCG_ADMIN_ORIGIN
  value: {{ required "admin.origin is required when admin.enabled=true" .Values.admin.origin | quote }}
- name: RCG_ADMIN_SESSION_TTL_MS
  value: {{ .Values.admin.sessionTtlMs | quote }}
- name: RCG_ADMIN_SESSION_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.existingSecret | quote }}
      key: {{ required "secretKeys.adminSessionPepper is required when admin.enabled=true" .Values.secretKeys.adminSessionPepper | quote }}
{{- else }}
- name: RCG_ADMIN_ENABLED
  value: "false"
{{- end }}
{{- if .Values.runtime.otlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.runtime.otlpEndpoint | quote }}
{{- end }}
{{- end }}
