{{- define "guild.spec.guild-juicefs" -}}
selector:
  matchLabels:
    app: guild-juicefs
template:
  metadata:
    labels:
      app: guild-juicefs
  spec:
    automountServiceAccountToken: false
    containers:
      - name: mount
        image: juicedata/mount:ce-v1.3.1
        securityContext:
          privileged: true
        env:
          - name: POSTGRES_PASSWORD
            valueFrom:
              secretKeyRef:
                name: guild-data
                key: postgres-password
          - name: GUILD_JUICE_META_URL
            value: postgres://guild:$(POSTGRES_PASSWORD)@postgres:5432/guild_juicefs?sslmode=disable
        command: [/bin/sh, -ec]
        args:
          - |
            if grep -q " /storage/volume .* - fuse.juicefs " /proc/self/mountinfo; then
              umount -l /storage/volume
            fi
            mkdir -p /storage/volume
            exec juicefs mount --cache-size 512 "$GUILD_JUICE_META_URL" /storage/volume
        readinessProbe:
          exec:
            command:
              - /bin/sh
              - -ec
              - 'grep -q " /storage/volume .* - fuse.juicefs " /proc/self/mountinfo && stat /storage/volume >/dev/null'
          periodSeconds: 3
        volumeMounts:
          - name: storage
            mountPath: /storage
            mountPropagation: Bidirectional
          - name: fuse
            mountPath: /dev/fuse
    volumes:
      - name: storage
        hostPath:
          path: /var/lib/guild-juicefs
          type: DirectoryOrCreate
      - name: fuse
        hostPath:
          path: /dev/fuse
          type: CharDevice
{{- end -}}

{{- define "guild.spec.guild-workspace-csi" -}}
selector:
  matchLabels:
    app: guild-workspace-csi
template:
  metadata:
    labels:
      app: guild-workspace-csi
  spec:
    automountServiceAccountToken: false
    containers:
      - name: csi
        securityContext:
          privileged: true
        ports:
          - containerPort: 50051
        readinessProbe:
          tcpSocket:
            port: 50051
        volumeMounts:
          - name: workspaces
            mountPath: /var/lib/guild-juicefs
            mountPropagation: HostToContainer
          - name: ate
            mountPath: /var/lib/ate
            mountPropagation: Bidirectional
          - name: socket
            mountPath: /var/lib/kubelet/plugins/workspace.csi.guild.dev
    volumes:
      - name: workspaces
        hostPath:
          path: /var/lib/guild-juicefs
          type: DirectoryOrCreate
      - name: ate
        hostPath:
          path: /var/lib/ate
          type: Directory
      - name: socket
        hostPath:
          path: /var/lib/kubelet/plugins/workspace.csi.guild.dev
          type: DirectoryOrCreate
{{- end -}}

{{- define "guild.spec.guild" -}}
replicas: 1
strategy:
  type: Recreate
selector:
  matchLabels:
    app: guild
template:
  metadata:
    labels:
      app: guild
  spec:
    automountServiceAccountToken: false
    securityContext:
      runAsNonRoot: true
      runAsUser: 1000
      runAsGroup: 1000
      fsGroup: 1000
    initContainers:
      - name: postgres-ready
        image: postgres:17
        command: [/bin/sh, -ec, 'until pg_isready -h postgres -U guild -d guild; do sleep 2; done']
      - name: workspace-ready
        image: postgres:17
        command: [/bin/sh, -ec, 'until grep -q " /juicefs/volume .* - fuse.juicefs " /proc/self/mountinfo; do sleep 2; done']
        volumeMounts:
          - name: workspaces
            mountPath: /juicefs
            mountPropagation: HostToContainer
            readOnly: true
    containers:
      - name: server
        ports:
          - containerPort: 8080
        envFrom:
          - secretRef:
              name: guild-server
        env:
          - name: POSTGRES_PASSWORD
            valueFrom:
              secretKeyRef:
                name: guild-data
                key: postgres-password
          - name: GUILD_DATABASE_URL
            value: postgres://guild:$(POSTGRES_PASSWORD)@postgres:5432/guild
          - name: GUILD_BIND_ADDR
            value: 0.0.0.0:8080
          - name: GUILD_API_URL
            value: http://guild:8080
          - name: GUILD_AGENT_WORKSPACE_ROOT
            value: /juicefs/volume
          - name: GUILD_AGENT_WORKSPACE_WRITE_ROOT
            value: /juicefs/volume
          - name: GUILD_DATA_DIR
            value: /data
          - name: GUILD_CLICKHOUSE_URL
            value: http://clickhouse:8123
          - name: GUILD_CLICKHOUSE_USER
            value: guild
          - name: GUILD_CLICKHOUSE_PASSWORD
            valueFrom:
              secretKeyRef:
                name: guild-data
                key: clickhouse-password
          - name: GUILD_S3_URL
            value: http://rustfs:9000
          - name: GUILD_S3_BUCKET
            value: guild
          - name: GUILD_S3_ACCESS_KEY_ID
            valueFrom:
              secretKeyRef:
                name: guild-data
                key: rustfs-access-key
          - name: GUILD_S3_SECRET_ACCESS_KEY
            valueFrom:
              secretKeyRef:
                name: guild-data
                key: rustfs-password
          - name: GUILD_SANDBOX_RUNNER_URL
            value: http://guild-substrate:8090
          - name: GUILD_WORKER_MODE
            value: "on"
          - name: GUILD_WORKER_LIMIT
            value: "4"
          - name: GUILD_CURL_FETCH_URL
            value: http://curl-fetch:8080
        readinessProbe:
          httpGet:
            path: /api/v1/health
            port: 8080
        volumeMounts:
          - name: data
            mountPath: /data
          - name: workspaces
            mountPath: /juicefs
            mountPropagation: HostToContainer
    volumes:
      - name: workspaces
        hostPath:
          path: /var/lib/guild-juicefs
          type: Directory
      - name: data
        persistentVolumeClaim:
          claimName: guild-data-dir
{{- end -}}

{{- define "guild.spec.curl-fetch" -}}
replicas: 1
selector:
  matchLabels:
    app: curl-fetch
template:
  metadata:
    labels:
      app: curl-fetch
  spec:
    automountServiceAccountToken: false
    containers:
      - name: curl-fetch
        ports:
          - containerPort: 8080
        readinessProbe:
          httpGet:
            path: /healthz
            port: 8080
{{- end -}}

{{- define "guild.spec.guild-substrate" -}}
replicas: 1
strategy:
  type: Recreate
selector:
  matchLabels:
    app: guild-substrate
template:
  metadata:
    labels:
      app: guild-substrate
  spec:
    serviceAccountName: guild-substrate
    automountServiceAccountToken: false
    securityContext:
      runAsUser: 1000
      runAsGroup: 1000
      fsGroup: 1000
      runAsNonRoot: true
    containers:
      - name: adapter
        env:
          - name: GUILD_SANDBOX_RUNNER_TOKEN
            valueFrom:
              secretKeyRef:
                name: guild-server
                key: GUILD_SANDBOX_RUNNER_TOKEN
        ports:
          - containerPort: 8090
        readinessProbe:
          tcpSocket:
            port: 8090
        volumeMounts:
          - name: substrate
            mountPath: /run/substrate
            readOnly: true
          - name: kube
            mountPath: /run/kube
            readOnly: true
    volumes:
      - name: substrate
        projected:
          sources:
            - serviceAccountToken:
                audience: api.ate-system.svc
                path: token
            - podCertificate:
                signerName: podidentity.podcert.ate.dev/identity
                keyType: ECDSAP256
                credentialBundlePath: credential.pem
            - clusterTrustBundle:
                signerName: servicedns.podcert.ate.dev/identity
                labelSelector:
                  matchLabels:
                    podcert.ate.dev/canarying: live
                path: trust.pem
      - name: kube
        projected:
          sources:
            - serviceAccountToken:
                path: token
            - configMap:
                name: kube-root-ca.crt
                items:
                  - key: ca.crt
                    path: ca.crt
{{- end -}}
