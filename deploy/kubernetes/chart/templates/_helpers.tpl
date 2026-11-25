{{- define "guild.image" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- required (printf "images.%s is required" $name) (index $root.Values.images $name) | quote -}}
{{- end -}}

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
      {{- if ne .name "GUILD_ATESPACE" -}}
        {{- $env = append $env . -}}
      {{- end -}}
    {{- end -}}
    {{- $_ := set . "env" (append $env (dict "name" "GUILD_ATESPACE" "value" (required "atespace is required" $root.Values.atespace))) -}}
  {{- end -}}
{{- end -}}
{{- toYaml $spec -}}
{{- end -}}
