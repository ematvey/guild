{{- define "guild.workspaceDriver" -}}
{{- $name := required "workspaceDriverName is required" .Values.workspaceDriverName -}}
{{- if not (and (le (len $name) 63) (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$" $name)) -}}
{{- fail "workspaceDriverName must be a DNS name of at most 63 characters" -}}
{{- end -}}
{{- $name -}}
{{- end -}}

{{- define "guild.workspaceWorkerSelector" -}}
{{- $driver := include "guild.workspaceDriver" . -}}
{{- if eq $driver "workspace.csi.guild.dev" -}}
sandbox
{{- else -}}
{{- $driver -}}
{{- end -}}
{{- end -}}

{{- define "guild.workspaceHostPath" -}}
{{- $driver := include "guild.workspaceDriver" . -}}
{{- if eq $driver "workspace.csi.guild.dev" -}}
/var/lib/guild-juicefs
{{- else -}}
{{- printf "/var/lib/guild-juicefs-%s" $driver -}}
{{- end -}}
{{- end -}}

{{- define "guild.workloadSpec" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $fallback := index . 2 | fromYaml -}}
{{- $spec := deepCopy (default $fallback (index $root.Values.workloadSpecs $name)) -}}
{{- $driver := include "guild.workspaceDriver" $root -}}
{{- $socketDirectory := printf "/var/lib/kubelet/plugins/%s" $driver -}}
{{- if eq $name "guild-workspace-csi" -}}
  {{- range $spec.template.spec.volumes -}}
    {{- if eq .name "socket" -}}
      {{- $_ := set .hostPath "path" $socketDirectory -}}
    {{- end -}}
  {{- end -}}
{{- end -}}
{{- range $spec.template.spec.containers -}}
  {{- if has .name (list "server" "curl-fetch" "adapter" "csi") -}}
    {{- $_ := set . "image" (required (printf "images.%s is required" .name) (index $root.Values.images .name)) -}}
    {{- $_ := set . "imagePullPolicy" $root.Values.images.pullPolicy -}}
  {{- end -}}
  {{- if eq .name "csi" -}}
    {{- range .volumeMounts -}}
      {{- if eq .name "socket" -}}
        {{- $_ := set . "mountPath" $socketDirectory -}}
      {{- end -}}
    {{- end -}}
  {{- end -}}
  {{- if has .name (list "adapter" "csi") -}}
    {{- $env := list -}}
    {{- range .env -}}
      {{- if not (has .name (list "GUILD_WORKSPACE_CSI_DRIVER" "GUILD_WORKSPACE_WORKER_SELECTOR")) -}}
        {{- $env = append $env . -}}
      {{- end -}}
    {{- end -}}
    {{- $env = append $env (dict "name" "GUILD_WORKSPACE_CSI_DRIVER" "value" $driver) -}}
    {{- if eq .name "adapter" -}}
      {{- $env = append $env (dict "name" "GUILD_WORKSPACE_WORKER_SELECTOR" "value" (include "guild.workspaceWorkerSelector" $root)) -}}
    {{- end -}}
    {{- $_ := set . "env" $env -}}
  {{- end -}}
  {{- if eq .name "server" -}}
    {{- $origin := $root.Values.publicOrigin -}}
    {{- if and (not $origin) $root.Values.ingress.host -}}
      {{- $origin = printf "https://%s" $root.Values.ingress.host -}}
    {{- end -}}
    {{- if $origin -}}
      {{- $env := list -}}
      {{- range .env -}}
        {{- if ne .name "GUILD_API_URL" -}}
          {{- $env = append $env . -}}
        {{- end -}}
      {{- end -}}
      {{- $_ := set . "env" (append $env (dict "name" "GUILD_API_URL" "value" $origin)) -}}
    {{- end -}}
  {{- end -}}
  {{- if eq .name "adapter" -}}
    {{- $env := list -}}
    {{- range .env -}}
      {{- if not (has .name (list "GUILD_ATESPACE" "GUILD_ACTOR_IMAGE")) -}}
        {{- $env = append $env . -}}
      {{- end -}}
    {{- end -}}
    {{- $actorImage := required "images.actor is required when installing from source" $root.Values.images.actor -}}
    {{- if not (regexMatch "@sha256:[a-f0-9]{64}$" $actorImage) -}}
      {{- fail "images.actor must be pinned to a sha256 digest" -}}
    {{- end -}}
    {{- $env = append $env (dict "name" "GUILD_ATESPACE" "value" (required "atespace is required" $root.Values.atespace)) -}}
    {{- $_ := set . "env" (append $env (dict "name" "GUILD_ACTOR_IMAGE" "value" $actorImage)) -}}
  {{- end -}}
{{- end -}}
{{- toYaml $spec -}}
{{- end -}}
