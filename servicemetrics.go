package main

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const serviceMetricTimeout = 25 * time.Second
const serviceMetricInterval = 5 * time.Second
const serviceMetricRetention = 24 * time.Hour
const metricHostParseError = "metric-host-parse-failed"

type ServiceMetricAvailability struct {
	CPU     string `json:"cpu"`
	Memory  string `json:"memory"`
	Network string `json:"network"`
	Disk    string `json:"disk"`
}

type ServiceMetricSample struct {
	TargetID       string                    `json:"targetID"`
	TargetName     string                    `json:"targetName"`
	Kind           string                    `json:"kind"`
	Runtime        string                    `json:"runtime"`
	ID             string                    `json:"id"`
	Name           string                    `json:"name"`
	Group          string                    `json:"group,omitempty"`
	Status         string                    `json:"status,omitempty"`
	CPUCores       int                       `json:"cpuCores"`
	CPUPercent     *float64                  `json:"cpuPercent,omitempty"`
	CPUTimeNS      *float64                  `json:"cpuTimeNS,omitempty"`
	MemoryBytes    *float64                  `json:"memoryBytes,omitempty"`
	MemoryLimit    *float64                  `json:"memoryLimit,omitempty"`
	NetworkRxBytes *float64                  `json:"networkRxBytes,omitempty"`
	NetworkTxBytes *float64                  `json:"networkTxBytes,omitempty"`
	DiskReadBytes  *float64                  `json:"diskReadBytes,omitempty"`
	DiskWriteBytes *float64                  `json:"diskWriteBytes,omitempty"`
	Availability   ServiceMetricAvailability `json:"availability"`
	Partial        bool                      `json:"partial,omitempty"`
}

type ServiceMetricSnapshot struct {
	Target    ServiceTarget         `json:"target"`
	Timestamp string                `json:"timestamp"`
	Samples   []ServiceMetricSample `json:"samples"`
	Errors    map[string]string     `json:"errors"`
	Error     string                `json:"error,omitempty"`
}

// ServiceMetricTrendPoint 是后端换算后的趋势点：CPU 与网络/磁盘速率都已按相邻采样算好，
// 前端只按时间序列绘制，不再自己维护上一次采样。
type ServiceMetricTrendPoint struct {
	Key         string   `json:"key"`
	Sequence    uint64   `json:"sequence"`
	Timestamp   int64    `json:"timestamp"`
	CPU         *float64 `json:"cpu,omitempty"`
	Memory      *float64 `json:"memory,omitempty"`
	MemoryLimit *float64 `json:"memoryLimit,omitempty"`
	NetworkRx   *float64 `json:"networkRx,omitempty"`
	NetworkTx   *float64 `json:"networkTx,omitempty"`
	DiskRead    *float64 `json:"diskRead,omitempty"`
	DiskWrite   *float64 `json:"diskWrite,omitempty"`
}

// ServiceMetricTrend 是一次趋势拉取的返回：Snapshots 为每个目标的最新快照（表格与错误展示），
// Points 为序列号大于请求游标的增量点。
type ServiceMetricTrend struct {
	Running   bool                      `json:"running"`
	Sequence  uint64                    `json:"sequence"`
	Snapshots []ServiceMetricSnapshot   `json:"snapshots"`
	Points    []ServiceMetricTrendPoint `json:"points"`
}

type serviceMetricRaw struct {
	timestamp time.Time
	sample    ServiceMetricSample
}

type hostMetricValues struct {
	System         string
	CPUCores       int
	CPUPercent     *float64
	MemoryBytes    *float64
	MemoryLimit    *float64
	NetworkRxBytes *float64
	NetworkTxBytes *float64
	DiskReadBytes  *float64
	DiskWriteBytes *float64
}

// StartServiceMetrics 启动常驻采样：按固定间隔采集目标，并在内存保留最近一小时的趋势，
// 页面离开后仍继续。幂等：目标集合未变时重复调用无副作用，目标变化时替换采样循环。
func (s *ServiceManagerService) StartServiceMetrics(targetIDs []string) error {
	if s == nil {
		return nil
	}
	ids := normalizeServiceMetricTargetIDs(targetIDs)
	s.metricMu.Lock()
	defer s.metricMu.Unlock()
	if s.metricRunning && sameServiceMetricTargets(s.metricTargets, ids) {
		return nil
	}
	if s.metricCancel != nil {
		s.metricCancel()
		s.metricCancel = nil
	}
	s.metricCtx = nil
	if len(ids) == 0 {
		s.metricRunning = false
		s.metricTargets = nil
		return nil
	}
	if len(s.metricTargets) > 0 {
		s.pruneServiceMetricStateLocked(ids)
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.metricCtx = ctx
	s.metricCancel = cancel
	s.metricRunning = true
	s.metricTargets = ids
	go s.runServiceMetrics(ctx, ids)
	return nil
}

// StopServiceMetrics 停止常驻采样，保留已缓存趋势，恢复后继续追加。
func (s *ServiceManagerService) StopServiceMetrics() error {
	if s == nil {
		return nil
	}
	s.metricMu.Lock()
	defer s.metricMu.Unlock()
	if s.metricCancel != nil {
		s.metricCancel()
		s.metricCancel = nil
	}
	s.metricRunning = false
	s.metricCtx = nil
	return nil
}

// GetServiceMetricsTrend 返回序号大于 sinceSequence 的增量趋势点，以及每个目标的最新快照。
func (s *ServiceManagerService) GetServiceMetricsTrend(sinceSequence uint64) ServiceMetricTrend {
	result := ServiceMetricTrend{Running: false, Snapshots: []ServiceMetricSnapshot{}, Points: []ServiceMetricTrendPoint{}}
	if s == nil {
		return result
	}
	s.metricMu.Lock()
	defer s.metricMu.Unlock()
	result.Running = s.metricRunning
	result.Sequence = s.metricSequence
	for _, point := range s.metricPoints {
		if point.Sequence > sinceSequence {
			result.Points = append(result.Points, point)
		}
	}
	for _, id := range s.metricTargets {
		if snapshot, ok := s.metricSnapshots[id]; ok {
			result.Snapshots = append(result.Snapshots, snapshot)
		}
	}
	return result
}

func (s *ServiceManagerService) runServiceMetrics(ctx context.Context, ids []string) {
	ticker := time.NewTicker(serviceMetricInterval)
	defer ticker.Stop()
	for {
		s.sampleServiceMetrics(ctx, ids)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *ServiceManagerService) sampleServiceMetrics(ctx context.Context, ids []string) {
	results := make([]ServiceMetricSnapshot, len(ids))
	var wg sync.WaitGroup
	for index, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[index] = s.collectServiceMetricSnapshot(id)
		}()
	}
	wg.Wait()

	timestamp := time.Now()
	s.metricMu.Lock()
	defer s.metricMu.Unlock()
	if !s.metricRunning || s.metricCtx != ctx {
		return
	}
	for index, snapshot := range results {
		s.metricSnapshots[ids[index]] = snapshot
		for _, sample := range snapshot.Samples {
			key := serviceMetricKey(sample)
			previous, ok := s.metricRaw[key]
			var previousValue *serviceMetricRaw
			if ok {
				previousValue = &previous
			}
			s.metricSequence++
			s.metricPoints = append(s.metricPoints, trendPointFromSample(key, sample, timestamp, previousValue, s.metricSequence))
			s.metricRaw[key] = serviceMetricRaw{timestamp: timestamp, sample: sample}
		}
	}
	s.trimServiceMetricPointsLocked(timestamp)
}

func (s *ServiceManagerService) trimServiceMetricPointsLocked(timestamp time.Time) {
	cutoff := timestamp.Add(-serviceMetricRetention).UnixMilli()
	index := 0
	for index < len(s.metricPoints) && s.metricPoints[index].Timestamp < cutoff {
		index++
	}
	if index == 0 {
		return
	}
	s.metricPoints = s.metricPoints[index:]
	if cap(s.metricPoints) > 2*len(s.metricPoints) {
		compacted := make([]ServiceMetricTrendPoint, len(s.metricPoints))
		copy(compacted, s.metricPoints)
		s.metricPoints = compacted
	}
}

func (s *ServiceManagerService) pruneServiceMetricStateLocked(targetIDs []string) {
	keep := make(map[string]bool, len(targetIDs))
	for _, id := range targetIDs {
		keep[id] = true
	}
	filtered := make([]ServiceMetricTrendPoint, 0, len(s.metricPoints))
	for _, point := range s.metricPoints {
		targetID, _, _ := strings.Cut(point.Key, "|")
		if keep[targetID] {
			filtered = append(filtered, point)
		}
	}
	s.metricPoints = filtered
	for key := range s.metricRaw {
		targetID, _, _ := strings.Cut(key, "|")
		if !keep[targetID] {
			delete(s.metricRaw, key)
		}
	}
	for id := range s.metricSnapshots {
		if !keep[id] {
			delete(s.metricSnapshots, id)
		}
	}
}

func normalizeServiceMetricTargetIDs(targetIDs []string) []string {
	seen := map[string]bool{}
	ids := make([]string, 0, len(targetIDs))
	for _, id := range targetIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

func sameServiceMetricTargets(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func serviceMetricKey(sample ServiceMetricSample) string {
	return sample.TargetID + "|" + sample.Kind + "|" + sample.Runtime + "|" + sample.ID
}

func trendPointFromSample(key string, sample ServiceMetricSample, timestamp time.Time, previous *serviceMetricRaw, sequence uint64) ServiceMetricTrendPoint {
	point := ServiceMetricTrendPoint{Key: key, Sequence: sequence, Timestamp: timestamp.UnixMilli()}
	seconds := 0.0
	if previous != nil {
		seconds = timestamp.Sub(previous.timestamp).Seconds()
	}
	if sample.CPUPercent != nil {
		point.CPU = copyMetricFloat(sample.CPUPercent)
	} else if previous != nil && sample.CPUTimeNS != nil && previous.sample.CPUTimeNS != nil {
		elapsed := *sample.CPUTimeNS - *previous.sample.CPUTimeNS
		cores := sample.CPUCores
		if cores < 1 {
			cores = 1
		}
		if elapsed >= 0 && seconds > 0 {
			value := elapsed / (seconds * 1_000_000_000 * float64(cores)) * 100
			point.CPU = &value
		}
	}
	point.Memory = copyMetricFloat(sample.MemoryBytes)
	point.MemoryLimit = copyMetricFloat(sample.MemoryLimit)
	if previous != nil {
		point.NetworkRx = metricRate(sample.NetworkRxBytes, previous.sample.NetworkRxBytes, seconds)
		point.NetworkTx = metricRate(sample.NetworkTxBytes, previous.sample.NetworkTxBytes, seconds)
		point.DiskRead = metricRate(sample.DiskReadBytes, previous.sample.DiskReadBytes, seconds)
		point.DiskWrite = metricRate(sample.DiskWriteBytes, previous.sample.DiskWriteBytes, seconds)
	}
	return point
}

func metricRate(current, previous *float64, seconds float64) *float64 {
	if current == nil || previous == nil || seconds <= 0 || *current < *previous {
		return nil
	}
	value := (*current - *previous) / seconds
	return &value
}

func copyMetricFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func (s *ServiceManagerService) collectServiceMetricSnapshot(targetID string) ServiceMetricSnapshot {
	target, source, dockerCLI, err := s.targetSnapshot(targetID)
	snapshot := ServiceMetricSnapshot{
		Target:    target,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Samples:   []ServiceMetricSample{},
		Errors:    map[string]string{},
	}
	if err != nil {
		snapshot.Target = ServiceTarget{ID: targetID}
		snapshot.Error = err.Error()
		return snapshot
	}
	ctx, cancel := context.WithTimeout(s.ctx, serviceMetricTimeout)
	defer cancel()

	host, hostErr := s.collectHostMetrics(ctx, source)
	if hostErr != nil {
		snapshot.Errors["source"] = hostErr.Error()
	}
	cores := host.CPUCores
	if cores < 1 {
		cores = 1
	}
	snapshot.Samples = append(snapshot.Samples, hostMetricSample(target, host))

	type runtimeResult struct {
		name    string
		samples []ServiceMetricSample
		err     error
	}
	results := make(chan runtimeResult, 3)
	go func() {
		items, collectErr := s.collectDockerMetrics(ctx, source, dockerCLI, target, cores)
		results <- runtimeResult{name: "docker", samples: items, err: collectErr}
	}()
	go func() {
		items, collectErr := s.collectPM2Metrics(ctx, source, target, cores)
		results <- runtimeResult{name: "pm2", samples: items, err: collectErr}
	}()
	go func() {
		items, collectErr := s.collectSystemdMetrics(ctx, source, target, cores)
		results <- runtimeResult{name: "systemd", samples: items, err: collectErr}
	}()
	for range 3 {
		result := <-results
		if result.err != nil {
			snapshot.Errors[result.name] = result.err.Error()
		}
		snapshot.Samples = append(snapshot.Samples, result.samples...)
	}
	return snapshot
}

func unavailableAvailability() ServiceMetricAvailability {
	return ServiceMetricAvailability{CPU: "unavailable", Memory: "unavailable", Network: "unavailable", Disk: "unavailable"}
}

func hostMetricSample(target ServiceTarget, values hostMetricValues) ServiceMetricSample {
	availability := unavailableAvailability()
	if values.CPUPercent != nil {
		availability.CPU = "available"
	}
	if values.MemoryBytes != nil {
		availability.Memory = "available"
	}
	if values.NetworkRxBytes != nil && values.NetworkTxBytes != nil {
		availability.Network = "available"
	}
	if values.DiskReadBytes != nil && values.DiskWriteBytes != nil {
		availability.Disk = "available"
	} else if values.System == "darwin" {
		availability.Disk = "unsupported"
	}
	return ServiceMetricSample{
		TargetID: target.ID, TargetName: target.Name, Kind: "source", Runtime: "host",
		ID: target.ID, Name: target.Name, Status: "online", CPUCores: values.CPUCores,
		CPUPercent: values.CPUPercent, MemoryBytes: values.MemoryBytes, MemoryLimit: values.MemoryLimit,
		NetworkRxBytes: values.NetworkRxBytes, NetworkTxBytes: values.NetworkTxBytes,
		DiskReadBytes: values.DiskReadBytes, DiskWriteBytes: values.DiskWriteBytes,
		Availability: availability,
	}
}

const hostMetricScript = `system=$(uname -s 2>/dev/null || true)
if [ "$system" = "Linux" ] && [ -r /proc/stat ]; then
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')
  first=$(awk '/^cpu / { total=0; for(i=2;i<=NF;i++) total+=$i; print total, $5+$6; exit }' /proc/stat)
  sleep 0.2
  second=$(awk '/^cpu / { total=0; for(i=2;i<=NF;i++) total+=$i; print total, $5+$6; exit }' /proc/stat)
  cpu=$(awk -v a="$first" -v b="$second" 'BEGIN { split(a,x," "); split(b,y," "); dt=y[1]-x[1]; di=y[2]-x[2]; if(dt>0) printf "%.4f", (dt-di)*100/dt }')
  memory=$(awk '/MemTotal:/ { total=$2*1024 } /MemAvailable:/ { available=$2*1024 } END { if(total>0) printf "%.0f\t%.0f", total-available, total }' /proc/meminfo)
  network=$(awk -F: '$1 !~ /^[[:space:]]*lo[[:space:]]*$/ { gsub(/^[[:space:]]+/,"",$2); n=split($2,a,/[[:space:]]+/); rx+=a[1]; tx+=a[9] } END { printf "%.0f\t%.0f", rx, tx }' /proc/net/dev)
  disk_read=; disk_write=; disk_found=0
  for f in /sys/block/*/stat; do
    [ -r "$f" ] || continue
    device=${f%/stat}; device=${device##*/}
    case "$device" in loop*|ram*|zram*|fd*|sr*|dm-*|md*) continue ;; esac
    set -- $(cat "$f")
    disk_read=$(( ${disk_read:-0} + ${3:-0} * 512 ))
    disk_write=$(( ${disk_write:-0} + ${7:-0} * 512 ))
    disk_found=1
  done
  [ "$disk_found" = "1" ] || { disk_read=; disk_write=; }
  printf '__TK_METRIC__\tlinux\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cores" "$cpu" "$memory" "$network" "$disk_read" "$disk_write"
elif [ "$system" = "Darwin" ]; then
  cores=$(sysctl -n hw.ncpu 2>/dev/null || printf '1')
  cpu=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$cores" '{ sum+=$1 } END { if(c>0) printf "%.4f", sum/c }')
  page=$(sysctl -n hw.pagesize 2>/dev/null || printf '4096')
  total=$(sysctl -n hw.memsize 2>/dev/null || true)
  available=$(vm_stat 2>/dev/null | awk -v p="$page" '/Pages free:/ { free=$3 } /Pages inactive:/ { inactive=$3 } /Pages speculative:/ { speculative=$3 } END { gsub(/\./,"",free); gsub(/\./,"",inactive); gsub(/\./,"",speculative); printf "%.0f", (free+inactive+speculative)*p }')
  used=$(awk -v t="$total" -v a="$available" 'BEGIN { if(t!="" && a!="") printf "%.0f", t-a }')
  network=$(netstat -ibn 2>/dev/null | awk 'NR==1 { for(i=1;i<=NF;i++){ if($i=="Name") ni=i; if($i=="Ibytes") ri=i; if($i=="Obytes") ti=i } } ni && ri && ti && $ni!="lo0" && $ri~/^[0-9]+$/ && $ti~/^[0-9]+$/ { seen=1; if($ri>rx[$ni]) rx[$ni]=$ri; if($ti>tx[$ni]) tx[$ni]=$ti } END { if(seen){for(n in rx){r+=rx[n]; t+=tx[n]} printf "%.0f\t%.0f", r, t} }')
  printf '__TK_METRIC__\tdarwin\t%s\t%s\t%s\t%s\t%s\t\t\n' "$cores" "$cpu" "$used" "$total" "$network"
else
  printf '__TK_METRIC__\tunknown\t1\t\t\t\t\t\t\t\n'
fi`

func (s *ServiceManagerService) collectHostMetrics(ctx context.Context, source ImageSource) (hostMetricValues, error) {
	out, err := s.run(ctx, source, "sh", "-lc", hostMetricScript)
	if err != nil {
		return hostMetricValues{CPUCores: 1}, err
	}
	values, err := parseHostMetricOutput(string(out))
	if err == nil && source.Kind == "local" {
		cores := runtime.NumCPU()
		if cores > 0 && values.System == "darwin" && values.CPUPercent != nil && values.CPUCores > 0 {
			adjusted := *values.CPUPercent * float64(values.CPUCores) / float64(cores)
			values.CPUPercent = &adjusted
		}
		if cores > 0 {
			values.CPUCores = cores
		}
	}
	return values, err
}

func parseHostMetricOutput(output string) (hostMetricValues, error) {
	for _, line := range strings.Split(output, "\n") {
		if !strings.HasPrefix(line, "__TK_METRIC__\t") {
			continue
		}
		parts := strings.Split(line, "\t")
		for len(parts) < 10 {
			parts = append(parts, "")
		}
		cores, _ := strconv.Atoi(parts[2])
		if cores < 1 {
			cores = 1
		}
		return hostMetricValues{
			System: parts[1], CPUCores: cores, CPUPercent: parseOptionalFloat(parts[3]),
			MemoryBytes: parseOptionalFloat(parts[4]), MemoryLimit: parseOptionalFloat(parts[5]),
			NetworkRxBytes: parseOptionalFloat(parts[6]), NetworkTxBytes: parseOptionalFloat(parts[7]),
			DiskReadBytes: parseOptionalFloat(parts[8]), DiskWriteBytes: parseOptionalFloat(parts[9]),
		}, nil
	}
	return hostMetricValues{CPUCores: 1}, errors.New(metricHostParseError)
}

func parseOptionalFloat(value string) *float64 {
	value = strings.TrimSpace(value)
	if value == "" || value == "-" || value == "[not set]" || value == "infinity" {
		return nil
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || number < 0 || number >= float64(^uint64(0)) {
		return nil
	}
	return &number
}

type dockerMetricJSON struct {
	ID       string `json:"ID"`
	Name     string `json:"Name"`
	CPUPerc  string `json:"CPUPerc"`
	MemUsage string `json:"MemUsage"`
	NetIO    string `json:"NetIO"`
	BlockIO  string `json:"BlockIO"`
}

func (s *ServiceManagerService) collectDockerMetrics(ctx context.Context, source ImageSource, cli string, target ServiceTarget, cores int) ([]ServiceMetricSample, error) {
	containers, err := s.listContainers(ctx, source, cli)
	if err != nil {
		return nil, err
	}
	statsByID := map[string]dockerMetricJSON{}
	if out, statsErr := s.run(ctx, source, cli, "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"); statsErr == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			var value dockerMetricJSON
			if strings.TrimSpace(line) != "" && json.Unmarshal([]byte(line), &value) == nil {
				statsByID[value.ID] = value
			}
		}
	} else if len(containers) > 0 {
		return dockerUnavailableSamples(target, containers, cores), statsErr
	}
	resources := make([]ServiceMetricSample, 0, len(containers))
	for _, container := range containers {
		sample := ServiceMetricSample{
			TargetID: target.ID, TargetName: target.Name, Kind: "resource", Runtime: "docker",
			ID: container.ID, Name: container.Name, Group: container.ComposeProject, Status: container.Status,
			CPUCores: cores, Availability: unavailableAvailability(),
		}
		if !container.Running {
			sample.Availability = ServiceMetricAvailability{CPU: "stopped", Memory: "stopped", Network: "stopped", Disk: "stopped"}
			resources = append(resources, sample)
			continue
		}
		value, ok := statsByID[container.ID]
		if !ok {
			resources = append(resources, sample)
			continue
		}
		if cpu := parsePercent(value.CPUPerc); cpu != nil {
			normalized := *cpu / float64(cores)
			sample.CPUPercent = &normalized
			sample.Availability.CPU = "available"
		}
		if current, limit := parseMetricPair(value.MemUsage); current != nil {
			sample.MemoryBytes, sample.MemoryLimit = current, limit
			sample.Availability.Memory = "available"
		}
		if received, sent := parseMetricPair(value.NetIO); received != nil && sent != nil {
			sample.NetworkRxBytes, sample.NetworkTxBytes = received, sent
			sample.Availability.Network = "available"
		}
		if read, written := parseMetricPair(value.BlockIO); read != nil && written != nil {
			sample.DiskReadBytes, sample.DiskWriteBytes = read, written
			sample.Availability.Disk = "available"
		}
		resources = append(resources, sample)
	}
	groups, _ := groupDockerContainers(containers)
	compose := aggregateComposeMetrics(target, groups, resources, cores)
	return append(compose, resources...), nil
}

func dockerUnavailableSamples(target ServiceTarget, containers []DockerContainer, cores int) []ServiceMetricSample {
	result := make([]ServiceMetricSample, 0, len(containers))
	for _, container := range containers {
		availability := unavailableAvailability()
		if !container.Running {
			availability = ServiceMetricAvailability{CPU: "stopped", Memory: "stopped", Network: "stopped", Disk: "stopped"}
		}
		result = append(result, ServiceMetricSample{TargetID: target.ID, TargetName: target.Name, Kind: "resource", Runtime: "docker", ID: container.ID, Name: container.Name, Group: container.ComposeProject, Status: container.Status, CPUCores: cores, Availability: availability})
	}
	return result
}

func aggregateComposeMetrics(target ServiceTarget, groups []DockerComposeGroup, resources []ServiceMetricSample, cores int) []ServiceMetricSample {
	byID := make(map[string]ServiceMetricSample, len(resources))
	for _, item := range resources {
		byID[item.ID] = item
	}
	result := make([]ServiceMetricSample, 0, len(groups))
	for _, group := range groups {
		sample := ServiceMetricSample{TargetID: target.ID, TargetName: target.Name, Kind: "compose", Runtime: "docker-compose", ID: group.ID, Name: group.Name, Group: group.Name, Status: "running", CPUCores: cores, Availability: unavailableAvailability()}
		available := [4]int{}
		for _, container := range group.Containers {
			item := byID[container.ID]
			addMetricValue(&sample.CPUPercent, item.CPUPercent, &available[0])
			addMetricValue(&sample.MemoryBytes, item.MemoryBytes, &available[1])
			addMetricValue(&sample.MemoryLimit, item.MemoryLimit, nil)
			addMetricValue(&sample.NetworkRxBytes, item.NetworkRxBytes, &available[2])
			addMetricValue(&sample.NetworkTxBytes, item.NetworkTxBytes, nil)
			addMetricValue(&sample.DiskReadBytes, item.DiskReadBytes, &available[3])
			addMetricValue(&sample.DiskWriteBytes, item.DiskWriteBytes, nil)
		}
		statuses := []*string{&sample.Availability.CPU, &sample.Availability.Memory, &sample.Availability.Network, &sample.Availability.Disk}
		for index, count := range available {
			if count > 0 {
				*statuses[index] = "available"
				if count < len(group.Containers) {
					sample.Partial = true
					*statuses[index] = "partial"
				}
			}
		}
		result = append(result, sample)
	}
	return result
}

func addMetricValue(target **float64, value *float64, count *int) {
	if value == nil {
		return
	}
	if *target == nil {
		zero := 0.0
		*target = &zero
	}
	**target += *value
	if count != nil {
		*count++
	}
}

func parsePercent(value string) *float64 {
	return parseOptionalFloat(strings.TrimSuffix(strings.TrimSpace(value), "%"))
}

func parseMetricPair(value string) (*float64, *float64) {
	left, right, ok := strings.Cut(value, "/")
	if !ok {
		return nil, nil
	}
	return parseMetricBytes(left), parseMetricBytes(right)
}

func parseMetricBytes(value string) *float64 {
	value = strings.ReplaceAll(strings.TrimSpace(value), " ", "")
	index := 0
	for index < len(value) && ((value[index] >= '0' && value[index] <= '9') || value[index] == '.') {
		index++
	}
	if index == 0 {
		return nil
	}
	number, err := strconv.ParseFloat(value[:index], 64)
	if err != nil {
		return nil
	}
	unit := strings.ToLower(value[index:])
	multiplier := map[string]float64{"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12, "kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40}[unit]
	if multiplier == 0 {
		return nil
	}
	result := number * multiplier
	return &result
}

func (s *ServiceManagerService) collectPM2Metrics(ctx context.Context, source ImageSource, target ServiceTarget, cores int) ([]ServiceMetricSample, error) {
	processes, err := s.listPM2(ctx, source)
	if err != nil {
		return nil, err
	}
	result := make([]ServiceMetricSample, 0, len(processes))
	for _, process := range processes {
		cpu := process.CPU / float64(cores)
		memory := float64(process.Memory)
		result = append(result, ServiceMetricSample{
			TargetID: target.ID, TargetName: target.Name, Kind: "resource", Runtime: "pm2", ID: process.ID,
			Name: process.Name, Status: process.Status, CPUCores: cores, CPUPercent: &cpu, MemoryBytes: &memory,
			Availability: ServiceMetricAvailability{CPU: "available", Memory: "available", Network: "unsupported", Disk: "unsupported"},
		})
	}
	return result, nil
}

type systemdMetricValues struct {
	ID             string
	Status         string
	CPUTimeNS      *float64
	MemoryBytes    *float64
	MemoryLimit    *float64
	NetworkRxBytes *float64
	NetworkTxBytes *float64
	DiskReadBytes  *float64
	DiskWriteBytes *float64
}

func (s *ServiceManagerService) collectSystemdMetrics(ctx context.Context, source ImageSource, target ServiceTarget, cores int) ([]ServiceMetricSample, error) {
	result := []ServiceMetricSample{}
	var firstErr error
	for _, scope := range []string{"system", "user"} {
		units, err := s.listSystemd(ctx, source, scope)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		values, err := s.systemdMetricValues(ctx, source, scope, units)
		if err != nil && firstErr == nil {
			firstErr = err
		}
		for _, unit := range units {
			value := values[unit.ID]
			availability := unavailableAvailability()
			if value.CPUTimeNS != nil {
				availability.CPU = "available"
			}
			if value.MemoryBytes != nil {
				availability.Memory = "available"
			}
			if value.NetworkRxBytes != nil && value.NetworkTxBytes != nil {
				availability.Network = "available"
			} else {
				availability.Network = "accounting-disabled"
			}
			if value.DiskReadBytes != nil && value.DiskWriteBytes != nil {
				availability.Disk = "available"
			} else {
				availability.Disk = "accounting-disabled"
			}
			result = append(result, ServiceMetricSample{
				TargetID: target.ID, TargetName: target.Name, Kind: "resource", Runtime: "systemd", ID: unit.ID,
				Name: unit.Name, Group: scope, Status: unit.ActiveState, CPUCores: cores,
				CPUTimeNS: value.CPUTimeNS, MemoryBytes: value.MemoryBytes, MemoryLimit: value.MemoryLimit,
				NetworkRxBytes: value.NetworkRxBytes, NetworkTxBytes: value.NetworkTxBytes,
				DiskReadBytes: value.DiskReadBytes, DiskWriteBytes: value.DiskWriteBytes, Availability: availability,
			})
		}
	}
	return result, firstErr
}

func (s *ServiceManagerService) systemdMetricValues(ctx context.Context, source ImageSource, scope string, units []SystemdUnit) (map[string]systemdMetricValues, error) {
	result := map[string]systemdMetricValues{}
	var firstErr error
	for start := 0; start < len(units); start += 40 {
		end := min(start+40, len(units))
		args := []string{"show"}
		if scope == "user" {
			args = append([]string{"--user"}, args...)
		}
		for _, unit := range units[start:end] {
			args = append(args, unit.ID)
		}
		args = append(args, "--property=Id,ActiveState,CPUUsageNSec,MemoryCurrent,MemoryMax,IOReadBytes,IOWriteBytes,IPIngressBytes,IPEgressBytes", "--no-pager")
		out, err := s.run(ctx, source, "systemctl", args...)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for id, value := range parseSystemdMetricOutput(string(out)) {
			result[id] = value
		}
	}
	return result, firstErr
}

func parseSystemdMetricOutput(output string) map[string]systemdMetricValues {
	result := map[string]systemdMetricValues{}
	current := systemdMetricValues{}
	commit := func() {
		if current.ID != "" {
			result[current.ID] = current
		}
		current = systemdMetricValues{}
	}
	for _, line := range append(strings.Split(output, "\n"), "") {
		if strings.TrimSpace(line) == "" {
			commit()
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch key {
		case "Id":
			current.ID = value
		case "ActiveState":
			current.Status = value
		case "CPUUsageNSec":
			current.CPUTimeNS = parseOptionalFloat(value)
		case "MemoryCurrent":
			current.MemoryBytes = parseOptionalFloat(value)
		case "MemoryMax":
			current.MemoryLimit = parseOptionalFloat(value)
		case "IOReadBytes":
			current.DiskReadBytes = parseOptionalFloat(value)
		case "IOWriteBytes":
			current.DiskWriteBytes = parseOptionalFloat(value)
		case "IPIngressBytes":
			current.NetworkRxBytes = parseOptionalFloat(value)
		case "IPEgressBytes":
			current.NetworkTxBytes = parseOptionalFloat(value)
		}
	}
	return result
}
