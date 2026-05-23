package api

import (
	"fmt"
	"net/http"
)

var schedulerJobs = []map[string]any{
	{"id": "check_expired", "name": "Check expired users", "description": "Disable expired Emby access", "manual_only": false, "enabled": true},
	{"id": "check_expiring", "name": "Check expiring users", "description": "Scan users that will expire soon", "manual_only": false, "enabled": true},
	{"id": "expiry_reminders", "name": "Expiry reminders", "description": "Send expiry reminders", "manual_only": false, "enabled": true},
	{"id": "daily_stats", "name": "Daily stats", "description": "Generate daily statistics summary", "manual_only": false, "enabled": true},
	{"id": "cleanup_sessions", "name": "Session cleanup", "description": "Check active Emby sessions", "manual_only": false, "enabled": true},
	{"id": "emby_sync", "name": "Emby sync", "description": "Sync local and Emby user state", "manual_only": true, "enabled": true},
	{"id": "cleanup_no_emby", "name": "Clean users without Emby", "description": "Clean long-unbound Emby users", "manual_only": false, "enabled": true, "runtime_params": []string{"days", "preserve_tg_bound", "ignore_enabled_flag"}},
	{"id": "enforce_group_membership", "name": "Telegram group enforcement", "description": "Validate required Telegram group membership", "manual_only": false, "enabled": true},
	{"id": "check_telegram_bindings", "name": "Telegram binding check", "description": "Detect duplicate or abnormal bindings", "manual_only": false, "enabled": true},
	{"id": "system_auto_update", "name": "System auto update", "description": "Run system update checks", "manual_only": false, "enabled": false},
	{"id": "cleanup_unused_uploads", "name": "Clean unused uploads", "description": "Delete unreferenced avatars and backgrounds", "manual_only": false, "enabled": true},
	{"id": "kick_unknown_group_members", "name": "Kick unknown group members", "description": "Kick unrecognized members from observed roster", "manual_only": true, "enabled": true, "runtime_params": []string{"dry_run", "max_per_run"}},
}

func (a *App) handleSchedulerJobs(w http.ResponseWriter, r *http.Request, _ Params) {
	jobs := make([]map[string]any, 0, len(schedulerJobs))
	for _, job := range schedulerJobs {
		item := cloneMap(job)
		jobID := fmt.Sprint(job["id"])
		if schedule, okSchedule := a.store.SchedulerSchedule(jobID); okSchedule {
			item["trigger_spec"] = schedule.TriggerSpec
			item["is_custom"] = schedule.IsCustom
		} else {
			item["trigger_spec"] = a.schedulerDefaultTriggerSpec(jobID)
			item["is_custom"] = false
		}
		item["default_trigger_spec"] = a.schedulerDefaultTriggerSpec(jobID)
		item["last_run"] = nil
		if runs := a.store.SchedulerRuns(jobID, 1); len(runs) > 0 {
			item["last_run"] = runs[0]
		}
		item["is_running"] = false
		jobs = append(jobs, item)
	}
	ok(w, "OK", map[string]any{"jobs": jobs})
}
func (a *App) handleSchedulerLastRun(w http.ResponseWriter, r *http.Request, params Params) {
	runs := a.store.SchedulerRuns(params["job_id"], 1)
	var last any
	if len(runs) > 0 {
		last = runs[0]
	}
	ok(w, "OK", map[string]any{"job_id": params["job_id"], "last_run": last})
}
func (a *App) handleSchedulerHistory(w http.ResponseWriter, r *http.Request, params Params) {
	runs := a.store.SchedulerRuns(params["job_id"], 20)
	ok(w, "OK", map[string]any{"job_id": params["job_id"], "history": runs, "total": len(runs)})
}
func (a *App) handleSchedulerSchedule(w http.ResponseWriter, r *http.Request, params Params) {
	jobID := params["job_id"]
	if !schedulerJobExists(jobID) {
		fail(w, http.StatusNotFound, "job not found")
		return
	}
	if r.Method == http.MethodDelete {
		schedule, err := a.store.SetSchedulerSchedule(jobID, a.schedulerDefaultTriggerSpec(jobID), false)
		if statusFromError(w, err) {
			return
		}
		ok(w, "schedule reset", map[string]any{"job_id": jobID, "trigger_spec": schedule.TriggerSpec, "is_custom": false})
		return
	}
	payload := decodeMap(r)
	spec := map[string]any{"type": firstNonEmpty(stringValue(payload, "type"), "interval")}
	if spec["type"] == "cron_daily" {
		spec["hour"] = clamp(intValue(payload, "hour", 0), 0, 23)
		spec["minute"] = clamp(intValue(payload, "minute", 0), 0, 59)
	} else {
		spec["type"] = "interval"
		spec["seconds"] = clamp(intValue(payload, "seconds", 3600), 60, 604800)
	}
	schedule, err := a.store.SetSchedulerSchedule(jobID, spec, true)
	if statusFromError(w, err) {
		return
	}
	ok(w, "schedule updated", map[string]any{"job_id": jobID, "trigger_spec": schedule.TriggerSpec, "is_custom": true})
}
