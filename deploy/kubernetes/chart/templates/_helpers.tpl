{{- define "guild.workloadSpec" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $fallback := index . 2 | fromYaml -}}
{{- $spec := deepCopy (default $fallback (index $root.Values.workloadSpecs $name)) -}}
{{- range $spec.template.spec.containers -}}
  {{- if has .name (list "server" "curl-fetch" "adapter" "csi") -}}
    {{- $_ := set . "image" (required (printf "images.%s is required" .name) (index $root.Values.images .name)) -}}
    {{- $_ := set . "imagePullPolicy" $root.Values.images.pullPolicy -}}
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
