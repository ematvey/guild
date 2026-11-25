// Guild's Substrate-only CSI bridge. It exposes an existing JuiceFS workspace
// to Substrate without granting the Actor credentials or the filesystem root.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/container-storage-interface/spec/lib/go/csi"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	driver     = "workspace.csi.guild.dev"
	workspaces = "/var/lib/guild-juicefs/volume"
	socket     = "/var/lib/kubelet/plugins/" + driver + "/csi.sock"
	actorRoot  = "/var/lib/ate/actors"
	uuid       = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)

var (
	workspaceKey = regexp.MustCompile("^(agents/" + uuid + "/" + uuid + "|(chats|workspaces)/" + uuid + "/[A-Za-z0-9_-]{1,64})$")
	actorTarget  = regexp.MustCompile("^" + actorRoot + "/(" + uuid + ")/volumes/(workspace)$")
)

type bridge struct {
	csi.UnimplementedIdentityServer
	csi.UnimplementedControllerServer
	csi.UnimplementedNodeServer
	mounts sync.Mutex
}

func (b *bridge) GetPluginInfo(context.Context, *csi.GetPluginInfoRequest) (*csi.GetPluginInfoResponse, error) {
	return &csi.GetPluginInfoResponse{Name: driver, VendorVersion: "0.1.0"}, nil
}

func (b *bridge) ControllerGetCapabilities(context.Context, *csi.ControllerGetCapabilitiesRequest) (*csi.ControllerGetCapabilitiesResponse, error) {
	return &csi.ControllerGetCapabilitiesResponse{Capabilities: []*csi.ControllerServiceCapability{
		{Type: &csi.ControllerServiceCapability_Rpc{Rpc: &csi.ControllerServiceCapability_RPC{Type: csi.ControllerServiceCapability_RPC_CREATE_DELETE_VOLUME}}},
	}}, nil
}

func (b *bridge) CreateVolume(_ context.Context, req *csi.CreateVolumeRequest) (*csi.CreateVolumeResponse, error) {
	key := req.Parameters["workspaceKey"]
	if !workspaceKey.MatchString(key) || !strings.HasPrefix(req.Name, "substrate-") {
		return nil, status.Error(codes.InvalidArgument, "invalid Guild workspace volume")
	}
	return &csi.CreateVolumeResponse{Volume: &csi.Volume{
		VolumeId: req.Name, CapacityBytes: req.GetCapacityRange().GetRequiredBytes(),
		VolumeContext: map[string]string{"workspaceKey": key},
	}}, nil
}

func (b *bridge) DeleteVolume(context.Context, *csi.DeleteVolumeRequest) (*csi.DeleteVolumeResponse, error) {
	// An Actor's lifetime is independent of its Guild workspace.
	return &csi.DeleteVolumeResponse{}, nil
}

func (b *bridge) NodeGetCapabilities(context.Context, *csi.NodeGetCapabilitiesRequest) (*csi.NodeGetCapabilitiesResponse, error) {
	return &csi.NodeGetCapabilitiesResponse{Capabilities: []*csi.NodeServiceCapability{
		{Type: &csi.NodeServiceCapability_Rpc{Rpc: &csi.NodeServiceCapability_RPC{Type: csi.NodeServiceCapability_RPC_UNKNOWN}}},
	}}, nil
}

func workspaceDir(key string) (int, error) {
	rootPath := workspaces
	if plain := os.Getenv("GUILD_PLAIN_WORKSPACE_ROOT"); plain != "" && !strings.HasPrefix(key, "agents/") {
		rootPath = plain
	}
	root, err := unix.Open(rootPath, unix.O_PATH|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	var fs unix.Statfs_t
	if err := unix.Fstatfs(root, &fs); err != nil || (rootPath == workspaces && fs.Type != unix.FUSE_SUPER_MAGIC) {
		unix.Close(root)
		return -1, errors.New("JuiceFS mount unavailable")
	}

	parts := strings.Split(key, "/")
	for i, part := range parts {
		mode := uint32(0755)
		if i == len(parts)-1 {
			mode = 0750
		}
		err = unix.Mkdirat(root, part, mode)
		if err != nil && !errors.Is(err, unix.EEXIST) {
			unix.Close(root)
			return -1, err
		}
		next, err := unix.Openat(root, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(root)
		if err != nil {
			return -1, err
		}
		root = next
		// Guild also writes agent configuration through the shared JuiceFS mount.
		if parts[0] == "agents" || i == len(parts)-1 {
			if err := unix.Fchown(root, 1000, 1000); err != nil {
				unix.Close(root)
				return -1, err
			}
		}
	}
	return root, nil
}

func validTarget(volumeID, path string) bool {
	match := actorTarget.FindStringSubmatch(path)
	return match != nil && volumeID == "substrate-"+match[1]+"-"+match[2]
}

func (b *bridge) NodePublishVolume(_ context.Context, req *csi.NodePublishVolumeRequest) (*csi.NodePublishVolumeResponse, error) {
	key := req.VolumeContext["workspaceKey"]
	if !workspaceKey.MatchString(key) || !validTarget(req.VolumeId, req.TargetPath) || req.Readonly {
		return nil, status.Error(codes.InvalidArgument, "invalid Guild workspace attachment")
	}
	b.mounts.Lock()
	defer b.mounts.Unlock()

	source, err := workspaceDir(key)
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "open workspace: %v", err)
	}
	defer unix.Close(source)

	var sourceStat, targetStat, parentStat unix.Stat_t
	if err := unix.Fstat(source, &sourceStat); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := unix.Lstat(req.TargetPath, &targetStat); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if targetStat.Mode&unix.S_IFMT != unix.S_IFDIR {
		return nil, status.Error(codes.FailedPrecondition, "target is not a directory")
	}
	if sourceStat.Dev == targetStat.Dev && sourceStat.Ino == targetStat.Ino {
		return &csi.NodePublishVolumeResponse{}, nil
	}
	parent := strings.TrimSuffix(req.TargetPath, "/workspace")
	if err := unix.Stat(parent, &parentStat); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if parentStat.Dev != targetStat.Dev {
		return nil, status.Error(codes.FailedPrecondition, "target already mounted")
	}
	if err := unix.Mount("/proc/self/fd/"+strconv.Itoa(source), req.TargetPath, "", unix.MS_BIND, ""); err != nil {
		return nil, status.Errorf(codes.Internal, "bind workspace: %v", err)
	}
	return &csi.NodePublishVolumeResponse{}, nil
}

func (b *bridge) NodeUnpublishVolume(_ context.Context, req *csi.NodeUnpublishVolumeRequest) (*csi.NodeUnpublishVolumeResponse, error) {
	if !validTarget(req.VolumeId, req.TargetPath) {
		return nil, status.Error(codes.InvalidArgument, "invalid Guild workspace attachment")
	}
	b.mounts.Lock()
	defer b.mounts.Unlock()
	if err := unix.Unmount(req.TargetPath, 0); err != nil && !errors.Is(err, unix.EINVAL) && !errors.Is(err, unix.ENOENT) {
		return nil, status.Errorf(codes.Internal, "unmount workspace: %v", err)
	}
	return &csi.NodeUnpublishVolumeResponse{}, nil
}

func main() {
	b := &bridge{}
	if err := os.MkdirAll("/var/lib/kubelet/plugins/"+driver, 0700); err != nil {
		log.Fatal(err)
	}
	if err := os.Remove(socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Fatal(err)
	}
	node, err := net.Listen("unix", socket)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Chmod(socket, 0600); err != nil {
		log.Fatal(err)
	}
	controller, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal(err)
	}

	nodeServer := grpc.NewServer()
	csi.RegisterIdentityServer(nodeServer, b)
	csi.RegisterNodeServer(nodeServer, b)
	controllerServer := grpc.NewServer()
	csi.RegisterIdentityServer(controllerServer, b)
	csi.RegisterControllerServer(controllerServer, b)
	go func() { log.Fatal(nodeServer.Serve(node)) }()
	log.Fatal(controllerServer.Serve(controller))
}
