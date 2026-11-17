import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region src/core/model.ts
/** Stable key of a thread across the whole domain. */
const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
* Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
* values that do not parse as a timestamp are returned unchanged.
*/
function isoTime(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
* The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
* and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
* while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
* an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
* main Session may only stop the work on it.
*/
function followupOwners(trigger, records) {
	if (!trigger.human) return [];
	const disposition = records.triggers.disposition(trigger.id);
	if (!disposition || disposition.requeued) return [];
	const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
	const reached = disposition.fanout.filter((id) => !returned.has(id) && !disposition.context?.includes(id));
	if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id)) return [];
	return reached.filter((id) => {
		const ticket = records.tickets.get(id);
		return !!ticket && (liveTicket(ticket) || ticket.ended?.by !== "human" && ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && ticket.undelivered.includes(input.id)));
	});
}
/**
* Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
* work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
*/
const settled = (decision) => !["stop", "unavailable"].includes(decision.kind) && !decision.reason.some((reason) => [
	"stopNotExplicit",
	"stopUnknown",
	"routed"
].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
const runningAssignment = (ticket) => ticket.assignments.find((assignment) => assignment.state === "running");
/**
* Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
* to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
*/
function reached(ticket, trigger, thread, context = true) {
	if (ticket.origin.triggerId === trigger.id) return true;
	const input = ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === trigger.id);
	return trigger.threads.some((ref) => {
		const current = thread(threadKey(ref));
		return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
	}) || input && (context || !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id)));
}
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/**
* Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
* is false, or the end of its latest turn, whichever is later.
*/
function readUntil(ticket, progress = true) {
	return [(ticket.assignments.findLast((assignment) => assignment.report && (progress || assignment.report.state !== "progress"))?.report)?.at ?? "", ...ticket.assignments.map((assignment) => assignment.idleAt ?? "")].reduce((a, b) => a > b ? a : b);
}
/**
* Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
* since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	return !ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at > report.at);
}
//#endregion
//#region src/core/errors.ts
/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
const USER_ERRORS = {
	unknownTicket: ["missing", "Unknown ticket"],
	unknownProblem: ["missing", "Unavailable Eval not found"],
	unknownTrigger: ["missing", "Unknown trigger"],
	unknownAssignment: ["missing", "Unknown assignment"],
	unknownBlock: ["missing", "Unknown settings block: {block}"],
	unknownPromptRevision: ["missing", "Unknown prompt revision {revision}"],
	unknownPromptPart: ["refused", "Unknown built-in prompt part {part}"],
	ticketEnded: ["refused", "Ticket has ended"],
	assignmentEnded: ["refused", "Assignment has ended; a newer assignment owns this ticket"],
	evalFinished: ["refused", "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"],
	notAdmissible: ["refused", "Trigger is not admissible: {reason}"],
	notExplicit: ["refused", "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide"],
	ticketStopped: ["refused", "A person stopped this ticket; new work needs an accept through orchestrator_route"],
	mandateRevoked: ["refused", "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"],
	notRetryable: ["refused", "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"],
	sourceThread: ["refused", "This is the thread the ticket started on; it stays subscribed"],
	followedThread: ["refused", "This thread is the ticket's own, such as its pull request's; it stays subscribed"],
	notFollowing: ["refused", "This ticket does not follow that thread"],
	questionWithResult: ["refused", "A question for a person cannot also be a ready result or an answer; report it separately"],
	askerWithoutQuestion: ["refused", "The message that raised a question needs the question it raised"],
	notAsker: ["refused", "A question must name the person's message that raised it, which reached this ticket"],
	notAnswerable: ["refused", "An answer must name the person's question it answers, which reached this ticket"],
	ackEnded: ["refused", "Ticket ended; do not acknowledge historical requests"],
	notReached: ["refused", "Trigger does not belong to this worker"],
	handedBack: ["refused", "This ticket handed that trigger back already"],
	handedBackHere: ["refused", "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"],
	workerDecides: ["refused", "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop"],
	ackNoChannel: ["refused", "Acknowledgement requires an assigned human source message"],
	ackNotPerson: ["refused", "Use the original human trigger, not a bot, CI or worker report"],
	notReady: ["refused", "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."],
	notAttention: ["refused", "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."],
	notQuestion: ["refused", "An answer must target the original human question, not a worker report or automated trigger"],
	noAnswer: ["refused", "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."],
	noChannel: ["refused", "No reply channel for this ticket or trigger"],
	panelOnlyEnvironment: ["refused", "The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel"],
	panelOnlyAccounts: ["refused", "Source fields that setup reads, such as account CLIs, can only be changed in the management panel"],
	setupComplete: ["refused", "Setup is complete"],
	modelUnavailable: ["refused", "The {block} model is not available: {error}"],
	promptTooLong: ["refused", "Prompt configuration exceeds {limit} characters"],
	promptPlaceholders: ["refused", "The “{part}” template must keep {placeholders}, which the system fills in"],
	promptPartEmpty: ["refused", "The “{part}” part cannot be empty; reset it to follow its built-in text"],
	sourceNotInstalled: ["refused", "The {source} Source kind is not installed"],
	noLabels: ["refused", "This Source has no names to refresh"],
	nothingToSync: ["refused", "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup"]
};
/**
* Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
* Tool handlers and HTTP routes inspect its code and missing flag to return appropriate status responses, while the web panel localizes the code.
*/
var UserError = class extends Error {
	code;
	values;
	missing;
	constructor(code, values = {}) {
		const [kind, text] = USER_ERRORS[code];
		super(text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match));
		this.code = code;
		this.values = values;
		this.missing = kind === "missing";
	}
};
//#endregion
//#region src/core/ids.ts
/** Stable content-derived identifiers; equal inputs always produce the same id. */
function key(...values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}
//#endregion
//#region src/core/part.ts
/** Shared base class and configuration for Engine domain parts. */
/**
* Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
* Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
*/
var EnginePart = class {
	options;
	repo;
	constructor(options) {
		this.options = options;
		this.repo = options.repo;
	}
	now() {
		return this.options.now?.() ?? (/* @__PURE__ */ new Date()).toISOString();
	}
	policy() {
		return this.options.policy();
	}
	/** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
	owners(trigger) {
		return followupOwners(trigger, this.repo);
	}
	/** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
	leftToWorkers(trigger) {
		const owners = this.owners(trigger);
		if (owners.length) throw new UserError("workerDecides", { tickets: owners.join(", ") });
	}
	/**
	* Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
	* ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
	* Eval or one on a Thread it follows for context, went to Eval without it.
	* @returns whether it was queued.
	*/
	handBack(ticketId, trigger, reason) {
		const decided = this.owners(trigger).includes(ticketId);
		const disposition = this.repo.triggers.disposition(trigger.id) ?? {
			fanout: [],
			at: this.now()
		};
		const handbacks = [...disposition.handbacks ?? [], {
			ticketId,
			reason,
			at: this.now()
		}];
		this.repo.triggers.saveDisposition(trigger.id, {
			...disposition,
			handbacks
		});
		return decided && !this.owners(trigger).length && this.queueForEval(trigger);
	}
	/** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
	takeUp(ticketId, triggerId) {
		const disposition = this.repo.triggers.disposition(triggerId);
		if (disposition && !disposition.acked?.includes(ticketId)) this.repo.triggers.saveDisposition(triggerId, {
			...disposition,
			acked: [...disposition.acked ?? [], ticketId]
		});
	}
	/** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
	queueForEval(trigger) {
		const primary = this.thread(trigger.threads[0]);
		if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id)) return false;
		primary.pending.push(trigger.id);
		this.repo.threads.save(primary);
		return true;
	}
	emit(type, data) {
		this.options.emit?.({
			type,
			at: this.now(),
			data
		});
	}
	require(ticketId) {
		const ticket = this.repo.tickets.get(ticketId);
		if (!ticket) throw new UserError("unknownTicket");
		return ticket;
	}
	/** Returns the stored Thread or an unsaved empty Thread aggregate. */
	thread(ref) {
		const k = threadKey(ref);
		return this.repo.threads.get(k) ?? {
			key: k,
			ref: {
				source: ref.source,
				id: ref.id
			},
			createdAt: this.now(),
			subscriptions: [],
			correlated: [],
			pending: [],
			meta: {}
		};
	}
	ticketsOnThread(thread) {
		return thread.subscriptions.flatMap((id) => {
			const ticket = this.repo.tickets.get(id);
			return ticket ? [ticket] : [];
		});
	}
	source(ticket) {
		return this.repo.triggers.get(ticket.origin.triggerId);
	}
	reaches(ticket, trigger, context = true) {
		return reached(ticket, trigger, (k) => this.repo.threads.get(k), context);
	}
};
//#endregion
//#region src/core/stage.ts
/** Ticket stage classification and retry eligibility (docs/003). */
/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
function ticketStage(ticket) {
	if (ticket.ended) return { stage: "ended" };
	if (ticket.delivery) return {
		stage: "person",
		action: "delivery"
	};
	if (ticket.attention) return {
		stage: "person",
		action: "answer"
	};
	const assignment = latestAssignment(ticket);
	const report = assignment?.report?.state;
	if (report === "ready") return {
		stage: "person",
		action: "review"
	};
	if ((report === "blocked" || report === "failed") && waitsForPerson(ticket)) return {
		stage: "person",
		action: report
	};
	if (!assignment || assignment.state === "pending") return {
		stage: "working",
		action: "queued"
	};
	if (report === "waiting" || assignment.state === "ended") return { stage: "idle" };
	return { stage: "working" };
}
/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
function canRetry(ticket) {
	return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery);
}
//#endregion
//#region src/core/tickets.ts
/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
const sameChannel = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
const automatic = (input) => input?.kind === "note" || input?.kind === "trigger" && !input.human;
/**
* Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
* into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
*/
const readBefore = (input, until) => input.readAt === void 0 ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until;
const STATUS_REQUEST = "Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.";
/**
* Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
* Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
* Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
* Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
*/
var Tickets = class extends EnginePart {
	replies;
	constructor(options, replies) {
		super(options);
		this.replies = replies;
	}
	/**
	* Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
	* Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
	* gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
	*/
	create(id, decisionId, mandate, evaluation, outcome, at) {
		const { triggerIds } = evaluation;
		const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1));
		const origin = {
			triggerId: primary?.id ?? triggerIds[0],
			triggerIds
		};
		let ticket = {
			id,
			title: outcome.title,
			decisionId,
			mandate,
			channels: [],
			assignments: [],
			inputs: [],
			undelivered: [],
			createdAt: at,
			updatedAt: at,
			origin
		};
		for (const triggerId of triggerIds) {
			const channel = this.repo.triggers.get(triggerId)?.channel;
			if (channel && !ticket.channels.some((item) => sameChannel(item, channel))) ticket.channels.push(channel);
		}
		ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket;
		const assignment = this.newAssignment(ticket);
		this.repo.tickets.save(ticket);
		for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref);
		if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement);
		this.options.executor.start(this.require(id), assignment);
		this.emit("ticket.created", {
			ticketId: id,
			decisionId,
			strength: mandate.strength
		});
	}
	/**
	* Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	bind(ticketId, thread, own) {
		if (!liveTicket(this.require(ticketId))) throw new UserError("ticketEnded");
		this.subscribe(ticketId, thread);
		const ticket = this.require(ticketId);
		const followed = threadKey(thread);
		const follow = ticket.follows?.find((item) => item.thread === followed);
		if (follow) {
			follow.own ||= own;
			delete follow.closed;
		} else ticket.follows = [...ticket.follows ?? [], {
			thread: followed,
			own
		}];
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		return ticket;
	}
	/**
	* Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
	* work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
	*/
	threadClosed(thread, outcome, at) {
		const closed = threadKey(thread);
		for (const ticket of this.repo.tickets.open()) {
			const follow = ticket.follows?.find((item) => item.thread === closed && !item.closed);
			if (!follow) continue;
			follow.closed = {
				at,
				outcome
			};
			this.repo.tickets.save(ticket);
			const done = this.followsDone(ticket);
			if (!done || this.unfinished(ticket, at)) continue;
			const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? "") > Date.parse(at);
			this.end(ticket.id, "executor", done.outcome, resumed ? this.now() : done.at);
		}
	}
	/**
	* How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
	* once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
	*/
	followsDone(ticket) {
		const follows = ticket.follows ?? [];
		const own = follows.filter((item) => item.own);
		const counted = own.length ? own : follows;
		if (!counted.length || counted.some((item) => !item.closed)) return void 0;
		return counted.map((item) => item.closed).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
	}
	/**
	* The Trigger to attach to a ticket, once the ticket may take it.
	* @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
	*/
	attachable(ticketId, triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		this.leftToWorkers(trigger);
		const current = this.require(ticketId);
		if (current.ended?.by === "human") throw new UserError("ticketStopped");
		if (!liveTicket(current) && !this.policy().revalidate(current.mandate)) throw new UserError("mandateRevoked");
		return trigger;
	}
	/**
	* Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
	* then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
	* message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
	*/
	attach(ticketId, trigger, note) {
		for (const ref of trigger.threads) this.subscribe(ticketId, ref);
		const current = this.repo.triggers.disposition(trigger.id) ?? {
			fanout: [],
			at: this.now()
		};
		const { context, requeued, ...disposition } = current;
		const followed = context?.filter((id) => id !== ticketId);
		this.repo.triggers.saveDisposition(trigger.id, {
			...disposition,
			fanout: [.../* @__PURE__ */ new Set([...disposition.fanout, ticketId])],
			...followed?.length ? { context: followed } : {}
		});
		const ticket = this.require(ticketId);
		const id = key("input", ticketId, "trigger", trigger.id);
		const existing = ticket.inputs.find((input) => input.id === id);
		const at = this.now();
		const input = (inputId) => ({
			id: inputId,
			kind: "trigger",
			triggerId: trigger.id,
			at,
			...note ? { note } : {},
			...trigger.human ? { human: true } : {}
		});
		if (existing?.kind !== "trigger") this.addInput(ticket, input(id));
		else if (note && ticket.undelivered.includes(id)) {
			existing.note = note;
			ticket.updatedAt = at;
			this.repo.tickets.save(ticket);
		} else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "attached", at)));
		else if (note) this.addInput(ticket, input(key("input", ticketId, "trigger", trigger.id, "note", note)));
	}
	/**
	* Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
	* @returns whether the status request input was queued.
	* @throws UserError when the ticket is unknown.
	*/
	requestStatus(ticketId) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== "waiting") return false;
		this.addInput(ticket, {
			id: `status:${ticketId}:${ticket.updatedAt}`,
			kind: "text",
			text: STATUS_REQUEST,
			at: this.now()
		});
		return true;
	}
	/**
	* Stops a ticket on behalf of a human, ending any active assignments.
	* @throws UserError when the ticket is unknown.
	*/
	stop(ticketId, reason) {
		this.end(ticketId, "human", "stopped", this.now(), reason);
		return this.require(ticketId);
	}
	/**
	* Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
	* @throws UserError when the ticket is unknown or not retryable.
	*/
	retry(ticketId) {
		const ticket = this.require(ticketId);
		const latest = latestAssignment(ticket);
		if (!canRetry(ticket) || !latest) throw new UserError("notRetryable");
		this.endAssignment(ticket, latest, "retried");
		this.requeueUntaken(ticket, latest);
		const assignment = this.newAssignment(ticket);
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		this.options.executor.stop(ticket, latest, "retried");
		this.options.executor.start(ticket, assignment);
		return ticket;
	}
	/**
	* Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
	* @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
	*/
	markUnrelated(ticketId, thread, reason) {
		const ticket = this.require(ticketId);
		if (this.source(ticket)?.threads.some((ref) => threadKey(ref) === thread)) throw new UserError("sourceThread");
		if (ticket.follows?.some((item) => item.thread === thread)) throw new UserError("followedThread");
		if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError("notFollowing");
		this.dropSubscriptions(thread, "executor", ticketId, reason);
		for (const trigger of this.triggersOf(ticket)) if (trigger.threads.some((ref) => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason);
	}
	/**
	* Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
	* were accepted; the others are left alone.
	*/
	policyChanged(from, to, effects) {
		const at = this.now();
		for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			const effect = effects.get(ticket.id);
			if (effect) this.addInput(ticket, {
				id: key("input", ticket.id, "policy", from, to, at),
				kind: "policy-changed",
				from,
				to,
				at,
				effect
			});
		}
	}
	/**
	* Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
	* followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
	* it received from the Thread.
	*/
	dropSubscriptions(thread, by, ticketId, reason) {
		const current = this.repo.threads.get(thread);
		const tickets = current?.subscriptions.filter((id) => ticketId === void 0 || id === ticketId) ?? [];
		if (!current || !tickets.length) return false;
		current.subscriptions = current.subscriptions.filter((id) => !tickets.includes(id));
		this.repo.threads.save(current);
		for (const id of tickets) {
			const ticket = this.repo.tickets.get(id);
			if (!ticket?.follows?.some((item) => item.thread === thread)) continue;
			const { follows: before, ...rest } = ticket;
			const follows = before.filter((item) => item.thread !== thread);
			this.repo.tickets.save(follows.length ? {
				...rest,
				follows
			} : rest);
		}
		for (const id of tickets) this.emit("thread.unsubscribed", {
			threadKey: current.key,
			ticketId: id,
			by,
			...reason ? { reason } : {}
		});
		return true;
	}
	/**
	* Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
	* failed once no person is waited for: a Policy change alone does not launch it again.
	*/
	addInput(ticket, input) {
		if (ticket.inputs.some((existing) => existing.id === input.id)) return;
		ticket.inputs.push(input);
		ticket.updatedAt = this.now();
		const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket);
		if (!held) ticket.undelivered.push(input.id);
		this.repo.tickets.save(ticket);
		if (!liveTicket(ticket) || held) return;
		const running = runningAssignment(ticket), latest = latestAssignment(ticket);
		if (running) this.options.executor.deliver(ticket, running);
		else if (latest?.state === "pending" && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest);
	}
	/**
	* Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
	* and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
	* takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
	* the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
	*/
	wake(ticketId) {
		const ticket = this.repo.tickets.get(ticketId);
		if (!ticket || liveTicket(ticket) || ticket.ended?.by === "human" || !ticket.undelivered.length) return;
		const policy = this.policy();
		if (policy.paused) return;
		if (!policy.revalidate(ticket.mandate)) {
			this.refuse(ticket);
			return;
		}
		const first = ticket.undelivered.map((id) => ticket.inputs.find((input) => input.id === id)).find((input) => input?.kind === "trigger" && input.human);
		if (first?.kind !== "trigger") return;
		const at = this.now();
		delete ticket.ended;
		ticket.updatedAt = at;
		const assignment = this.newAssignment(ticket);
		const resumed = {
			id: key("input", ticket.id, "resumed", first.triggerId),
			kind: "resumed",
			triggerId: first.triggerId,
			at
		};
		ticket.inputs.push(resumed);
		ticket.undelivered.unshift(resumed.id);
		this.repo.tickets.save(ticket);
		this.options.executor.start(ticket, assignment);
		this.emit("ticket.resumed", {
			ticketId,
			triggerId: first.triggerId
		});
	}
	/** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
	triggersOf(ticket, ids) {
		return ticket.inputs.flatMap((input) => input.kind === "trigger" && (!ids || ids.includes(input.id)) ? this.repo.triggers.get(input.triggerId) ?? [] : []);
	}
	/**
	* Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
	* acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
	*/
	takenUp(ticket, trigger) {
		const acked = this.repo.triggers.disposition(trigger.id)?.acked;
		return acked ? acked.includes(ticket.id) : this.options.outbox.status(key("ack", trigger.id)) !== void 0;
	}
	/** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
	untaken(ticket, ids) {
		return this.triggersOf(ticket, ids).filter((trigger) => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger));
	}
	/**
	* A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
	* messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
	* that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
	* up, a Decision settled it, or it is the message a stop ended this ticket on.
	*/
	letGo(ticketId, waiting, left) {
		for (const trigger of [...waiting, ...left]) {
			const disposition = this.repo.triggers.disposition(trigger.id);
			if (disposition?.fanout.includes(ticketId)) this.repo.triggers.saveDisposition(trigger.id, {
				...disposition,
				fanout: disposition.fanout.filter((id) => id !== ticketId)
			});
		}
		for (const trigger of left) {
			const disposition = this.repo.triggers.disposition(trigger.id);
			const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : void 0;
			const stopped = decision?.kind === "stop" && decision.ticketId === ticketId && !disposition?.handbacks?.length;
			const decided = !!decision && (settled(decision) || stopped);
			if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger);
		}
	}
	/** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
	refuse(ticket) {
		const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered);
		ticket.undelivered = [];
		this.repo.tickets.save(ticket);
		this.letGo(ticket.id, waiting, left);
	}
	/** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
	restart(ticket, running, reason, note) {
		this.endAssignment(ticket, running, reason);
		this.requeueUntaken(ticket, running);
		const assignment = this.newAssignment(ticket);
		const at = this.now();
		const input = {
			id: key("input", ticket.id, "restart", assignment.id),
			kind: "text",
			text: note,
			at
		};
		ticket.inputs.push(input);
		ticket.undelivered.push(input.id);
		ticket.updatedAt = at;
		this.repo.tickets.save(ticket);
		this.options.executor.start(ticket, assignment);
	}
	/**
	* Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
	* have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
	* in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
	*/
	requeueUntaken(ticket, replaced) {
		const untaken = ticket.inputs.filter((input) => input.kind === "trigger" && input.readAt === null && input.deliveredTo === replaced.id && !ticket.undelivered.includes(input.id));
		ticket.undelivered.unshift(...untaken.map((input) => input.id));
	}
	/**
	* End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
	* why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
	* the person's messages it decides that its worker did not read before its latest report or turn end, the report that
	* ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
	* the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
	*/
	end(ticketId, by, outcome, at = this.now(), reason) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) return;
		const stopping = ticket.assignments.filter((assignment) => assignment.state !== "ended");
		const why = reason && reason !== outcome ? { reason } : {};
		const until = readUntil(ticket);
		const waiting = this.triggersOf(ticket, ticket.undelivered);
		const left = this.untaken(ticket, ticket.inputs.flatMap((input) => input.kind === "trigger" && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []));
		ticket.ended = {
			at,
			by,
			outcome,
			...why
		};
		ticket.undelivered = [];
		ticket.updatedAt = this.now();
		delete ticket.attention;
		delete ticket.delivery;
		for (const assignment of stopping) {
			assignment.state = "ended";
			assignment.endedAt = at;
		}
		this.repo.tickets.save(ticket);
		this.letGo(ticketId, waiting, left);
		this.emit("ticket.ended", {
			ticketId,
			by,
			outcome,
			...why
		});
		for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome);
	}
	/**
	* Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
	* has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
	* after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
	* change asks for no work.
	*/
	unfinished(ticket, at) {
		const until = readUntil(ticket, false);
		const taken = this.triggersOf(ticket, ticket.inputs.flatMap((input) => input.kind === "trigger" && !readBefore(input, until) ? [input.id] : [])).some((trigger) => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger));
		const latest = latestAssignment(ticket);
		if (taken || !(Date.parse(latest?.createdAt ?? "") > Date.parse(at))) return taken;
		const report = latest?.report;
		const later = ticket.inputs.some((input) => input.kind !== "policy-changed" && Date.parse(input.at) > Date.parse(report?.at ?? ""));
		return report?.state !== "ready" || ticket.undelivered.length > 0 || later;
	}
	/** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
	newAssignment(ticket) {
		const assignment = {
			id: key("assignment", ticket.id, String(ticket.assignments.length)),
			state: "pending",
			createdAt: this.now()
		};
		ticket.assignments.push(assignment);
		delete ticket.delivery;
		return assignment;
	}
	endAssignment(ticket, assignment, reason) {
		assignment.state = "ended";
		assignment.endedAt = this.now();
		assignment.endedReason = reason;
		this.emit("assignment.ended", {
			ticketId: ticket.id,
			assignmentId: assignment.id,
			reason
		});
	}
	/**
	* Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	note(ticketId, text) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		const at = this.now();
		this.addInput(ticket, {
			id: key("input", ticketId, "note", at, text),
			kind: "note",
			text,
			at
		});
		return this.require(ticketId);
	}
	/**
	* Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
	* @returns false when the ticket follows the Thread already.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	followForContext(ticketId, ref) {
		if (!liveTicket(this.require(ticketId))) throw new UserError("ticketEnded");
		if (this.thread(ref).subscriptions.includes(ticketId)) return false;
		this.subscribe(ticketId, ref);
		const thread = this.thread(ref);
		thread.context = [...thread.context ?? [], ticketId];
		this.repo.threads.save(thread);
		return true;
	}
	/** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
	subscribe(ticketId, ref) {
		const thread = this.thread(ref);
		if (!thread.subscriptions.includes(ticketId)) {
			thread.subscriptions.push(ticketId);
			this.emit("thread.subscribed", {
				threadKey: thread.key,
				ticketId
			});
		}
		if (thread.context?.includes(ticketId)) thread.context = thread.context.filter((id) => id !== ticketId);
		this.repo.threads.save(thread);
	}
};
//#endregion
//#region src/core/assignments.ts
/** What the Executor and its workers report about the Assignments that run tickets. */
const RECOVERY_NOTE = "The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.";
/**
* Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
* reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
* interrupted it, and a worker's report with its question for a person. It depends on
* Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
* Executor's lifecycle callbacks and its workers' reports here.
*/
var Assignments = class extends EnginePart {
	tickets;
	replies;
	constructor(options, tickets, replies) {
		super(options);
		this.tickets = tickets;
		this.replies = replies;
	}
	/** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
	started(ticketId, assignmentId) {
		const ticket = this.require(ticketId);
		const assignment = ticket.assignments.find((item) => item.id === assignmentId);
		if (!assignment || assignment.state === "ended") return;
		assignment.state = "running";
		assignment.startedAt ??= this.now();
		ticket.updatedAt = this.now();
		this.repo.tickets.save(ticket);
		if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment);
		this.emit("assignment.started", {
			ticketId,
			assignmentId
		});
	}
	/**
	* Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
	* longer running. Its worker reads each once its Session takes it into a step (see `read`).
	*/
	delivered(ticketId, assignmentId, inputIds) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		ticket.undelivered = ticket.undelivered.filter((id) => !inputIds.includes(id));
		ticket.updatedAt = this.now();
		runningAssignment(ticket).deliveredAt = ticket.updatedAt;
		for (const input of ticket.inputs) if (input.kind === "trigger" && inputIds.includes(input.id)) {
			input.readAt ??= null;
			input.deliveredTo = assignmentId;
		}
		delete ticket.delivery;
		this.repo.tickets.save(ticket);
	}
	/** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
	read(ticketId, inputIds) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) return;
		for (const input of ticket.inputs) if (input.kind === "trigger" && inputIds.includes(input.id)) input.readAt ||= this.now();
		this.repo.tickets.save(ticket);
	}
	turnEnded(ticketId, assignmentId) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		runningAssignment(ticket).idleAt = this.now();
		this.repo.tickets.save(ticket);
	}
	deliveryFailed(ticketId, assignmentId, error) {
		const ticket = this.running(ticketId, assignmentId);
		if (!ticket) return;
		ticket.delivery = {
			error: error.slice(0, 300),
			at: this.now()
		};
		this.repo.tickets.save(ticket);
	}
	/**
	* Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
	* `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
	* session and flushes any waiting undelivered inputs.
	*/
	interrupted(ticketId, assignmentId) {
		const ticket = this.running(ticketId, assignmentId);
		const running = ticket && runningAssignment(ticket);
		if (!ticket || !running) return;
		const report = running.report;
		const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at;
		if (!(!!report && [
			"waiting",
			"ready",
			"blocked",
			"failed"
		].includes(report.state) && !busy)) this.tickets.restart(ticket, running, "hostRestarted", RECOVERY_NOTE);
		else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running);
	}
	/**
	* Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
	* inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
	* @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
	* or a question/answer referencing a non-human or unreached trigger.
	*/
	report(ticketId, report) {
		const ticket = this.require(ticketId);
		if (!liveTicket(ticket)) throw new UserError("ticketEnded");
		if (report.question && (report.state === "ready" || report.answers)) throw new UserError("questionWithResult");
		if (report.askedBy && !report.question) throw new UserError("askerWithoutQuestion");
		const person = (id, channel) => {
			const trigger = this.repo.triggers.get(id);
			return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false);
		};
		if (report.askedBy && !person(report.askedBy, true)) throw new UserError("notAsker");
		if (report.answers && !person(report.answers, false)) throw new UserError("notAnswerable");
		const assignment = runningAssignment(ticket) ?? latestAssignment(ticket);
		if (!assignment) throw new UserError("unknownAssignment");
		if (assignment.state === "ended") throw new UserError("assignmentEnded");
		const at = this.now();
		const previous = ticket.attention;
		const ask = (question) => ({
			id: key("attention", ticketId, question, at),
			question,
			...report.askedBy ? { triggerId: report.askedBy } : {}
		});
		const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous;
		const attention = report.question === null || report.state === "ready" ? void 0 : asked;
		if (attention) ticket.attention = attention;
		else delete ticket.attention;
		if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(previous.id);
		assignment.report = {
			state: report.state,
			summary: report.summary,
			at
		};
		ticket.updatedAt = at;
		if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers];
		if (report.answers) this.takeUp(ticketId, report.answers);
		if (report.state === "blocked" || report.state === "failed") ticket.undelivered = ticket.undelivered.filter((id) => !automatic(ticket.inputs.find((input) => input.id === id)));
		this.repo.tickets.save(ticket);
		const ready = !ticket.follows?.length ? "completed" : this.tickets.followsDone(ticket)?.outcome;
		const outcome = report.state === "dropped" ? this.tickets.followsDone(ticket)?.outcome ?? "dropped" : report.state === "ready" ? ready : void 0;
		if (outcome) this.tickets.end(ticketId, "executor", outcome, at);
		return this.require(ticketId);
	}
	/** The ticket, while it is open and `assignmentId` runs it. */
	running(ticketId, assignmentId) {
		const ticket = this.require(ticketId);
		return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : void 0;
	}
};
//#endregion
//#region src/core/reasons.ts
const said = (text) => ({
	code: "said",
	values: { text }
});
//#endregion
//#region src/core/evals.ts
/** Evals: the Thread-level assessments of queued Triggers, and the Decisions they end with. */
/** An outcome's reason: a code it carries, else the words its assessor or person wrote. */
const reasonOf = (reason) => [typeof reason === "string" ? said(reason) : reason];
const stronger = (a, b) => a === "explicit" || b === "explicit" ? "explicit" : "inferred";
/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2;
/**
* Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
* from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, stop,
* ignore, or unavailable. It depends on Tickets to create the ticket an accept decides and to end the one a stop names; the
* Engine routes the main Session's decisions, people's replays, worker handbacks, and the pass's Eval work here.
*/
var Evals = class extends EnginePart {
	tickets;
	constructor(options, tickets) {
		super(options);
		this.tickets = tickets;
	}
	/**
	* Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
	* processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
	* candidate has not reached the assessor's Session does not expire.
	*/
	due(thread, policy) {
		const evaluation = thread.evaluating;
		if (!evaluation || policy.paused && evaluation.pausedAt) return;
		const now = this.now();
		if (policy.paused) evaluation.pausedAt = now;
		else if (evaluation.pausedAt) {
			evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString();
			delete evaluation.pausedAt;
		} else if (evaluation.delivered && evaluation.deadline <= now) {
			this.expire(thread);
			return;
		} else return;
		this.repo.threads.save(thread);
	}
	/** An Eval's candidate reached the assessor's Session: its deadline counts from now. */
	delivered(evalId, policy) {
		const thread = this.repo.threads.active().find((item) => item.evaluating?.id === evalId);
		if (!thread?.evaluating || thread.evaluating.delivered) return;
		const now = this.now();
		thread.evaluating.delivered = now;
		thread.evaluating.deadline = new Date(Date.parse(now) + policy.evalTimeoutMs).toISOString();
		this.repo.threads.save(thread);
	}
	/**
	* An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
	* assessor does not drop requests; after that it is recorded unavailable.
	*/
	expire(thread) {
		const expired = (thread.expired ?? 0) + 1;
		if (expired > REQUEUES) {
			this.finish(thread, thread.evaluating, {
				kind: "unavailable",
				reason: [{ code: "timeout" }]
			});
			return;
		}
		const { id, triggerIds } = thread.evaluating;
		delete thread.evaluating;
		thread.expired = expired;
		thread.pending = [...triggerIds, ...thread.pending.filter((item) => !triggerIds.includes(item))];
		this.repo.threads.save(thread);
		this.options.assessor.release?.(id);
	}
	/** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
	start(threadKeyValue, policy) {
		const thread = this.repo.threads.get(threadKeyValue);
		const at = this.now();
		const delivered = (id) => {
			const trigger = this.repo.triggers.get(id);
			return !!trigger && this.owners(trigger).length > 0;
		};
		if (thread.pending.some(delivered)) {
			const followups = thread.pending.filter(delivered);
			thread.pending = thread.pending.filter((id) => !followups.includes(id));
			this.repo.threads.save(thread);
			for (const triggerId of followups) this.emit("trigger.followup", { triggerId });
			if (!thread.pending.length) return;
		}
		const accepted = this.accepted(thread.key);
		const started = thread.pending.filter((id) => accepted.has(id));
		const startedTicket = (id) => ({
			code: "startedTicket",
			triggerId: id,
			values: { ticket: accepted.get(id).ticketId }
		});
		if (started.length) this.ignore(thread, started, started.map(startedTicket), policy, at);
		const triggers = thread.pending.flatMap((id) => {
			const trigger = this.repo.triggers.get(id);
			return trigger ? [trigger] : [];
		});
		const tickets = this.ticketsOnThread(thread);
		const reasons = [];
		let strongest;
		for (const trigger of triggers) {
			const gate = policy.gate(trigger, thread, tickets);
			if (!gate.admissible) {
				reasons.push({
					code: gate.reason,
					triggerId: trigger.id
				});
				continue;
			}
			const later = gate.strength === strongest?.strength && trigger.at >= strongest.trigger.at;
			if (!strongest || stronger(strongest.strength, gate.strength) !== strongest.strength || later) strongest = {
				trigger,
				strength: gate.strength,
				basis: gate.basis
			};
		}
		if (!strongest) {
			if (thread.pending.length) this.ignore(thread, [...thread.pending], reasons.length ? reasons : [{ code: "noAdmissible" }], policy, at);
			this.repo.threads.save(thread);
			return;
		}
		const evalId = key("eval", thread.key, policy.version, at, ...thread.pending);
		const deadline = new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString();
		const { strength, trigger: { actor }, basis } = strongest;
		thread.evaluating = {
			id: evalId,
			threadKey: thread.key,
			triggerIds: thread.pending,
			primary: strongest.trigger.id,
			strength,
			actor,
			basis,
			policyVersion: policy.version,
			startedAt: at,
			deadline
		};
		thread.pending = [];
		this.repo.threads.save(thread);
		for (const trigger of triggers) this.repo.triggers.saveDisposition(trigger.id, {
			...this.repo.triggers.disposition(trigger.id) ?? {
				fanout: [],
				at
			},
			evalId
		});
		this.emit("eval.started", {
			evalId,
			threadKey: thread.key,
			triggerIds: thread.evaluating.triggerIds,
			strength: strongest.strength
		});
		this.options.assessor.request(this.candidateOf(thread));
	}
	/** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
	candidate(triggerId) {
		const thread = this.holding(triggerId);
		return thread && this.candidateOf(thread);
	}
	/**
	* Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
	* @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
	* ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
	* mode or without enabled matching rules.
	*/
	decide(triggerId, outcome) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		const held = this.holding(triggerId);
		if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError("evalFinished", { eval: outcome.evalId });
		const earlier = outcome.kind === "accept" ? this.accepted(threadKey(trigger.threads[0])).get(triggerId) : void 0;
		if (earlier) {
			const others = held?.evaluating?.triggerIds.filter((id) => id !== triggerId) ?? [];
			if (held && others.length) this.reassess(held, {
				code: "acceptedBefore",
				values: { trigger: triggerId }
			}, [triggerId]);
			else if (held) this.finish(held, held.evaluating, {
				kind: "ignore",
				reason: [{
					code: "startedTicket",
					triggerId,
					values: { ticket: earlier.ticketId }
				}]
			});
			return earlier;
		}
		if (outcome.kind !== "stop") this.leftToWorkers(trigger);
		const thread = held ?? this.thread(trigger.threads[0]);
		const evaluation = held?.evaluating ?? this.directEval(thread, trigger, outcome.kind, outcome.kind === "stop" ? outcome.ticketId : void 0);
		if (outcome.kind === "accept" && evaluation.strength !== "explicit" && !this.policy().admitsInferred(outcome.rules ?? [])) throw new UserError("notExplicit");
		return this.decideEval(thread, evaluation, outcome);
	}
	/**
	* Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
	* @throws UserError when the Trigger is unknown.
	*/
	reevaluate(triggerId) {
		if (!this.requeue(triggerId)) return false;
		this.emit("trigger.requeued", { triggerId });
		return true;
	}
	/** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
	requeue(triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		if (this.holding(triggerId)) return false;
		this.queueForEval(trigger);
		const disposition = this.repo.triggers.disposition(triggerId) ?? {
			fanout: [],
			at: this.now()
		};
		this.repo.triggers.saveDisposition(triggerId, {
			...disposition,
			requeued: true
		});
		return true;
	}
	/**
	* Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
	* when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
	* Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
	* and hands a Trigger back once.
	* @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
	*/
	handback(ticketId, triggerId, reason) {
		if (!this.require(ticketId).inputs.some((input) => input.kind === "trigger" && input.triggerId === triggerId)) throw new UserError("notReached");
		if (this.repo.triggers.disposition(triggerId)?.handbacks?.some((item) => item.ticketId === ticketId)) throw new UserError("handedBack");
		return this.handBack(ticketId, this.repo.triggers.get(triggerId), reason);
	}
	/**
	* Marks an `unavailable` Decision dismissed so the overview lists it no more.
	* @throws UserError when the Decision is unknown or not `unavailable`.
	*/
	dismiss(decisionId) {
		const decision = this.repo.decisions.get(decisionId);
		if (decision?.kind !== "unavailable") throw new UserError("unknownProblem");
		decision.dismissed = true;
		this.repo.decisions.save(decision);
		return decision;
	}
	/** Take a Trigger out of its Thread's queue because it was routed by hand. */
	withdraw(trigger) {
		const thread = this.repo.threads.get(threadKey(trigger.threads[0]));
		if (!thread?.pending.includes(trigger.id)) return;
		thread.pending = thread.pending.filter((id) => id !== trigger.id);
		this.repo.threads.save(thread);
	}
	/**
	* End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
	* queues them again for a fresh Eval without it.
	*/
	routed(triggerId, ticketId) {
		const held = this.holding(triggerId);
		const reason = {
			code: "routed",
			values: { ticket: ticketId }
		};
		if (held?.evaluating?.triggerIds.length === 1) this.finish(held, held.evaluating, {
			kind: "ignore",
			reason: [reason]
		});
		else if (held) this.reassess(held, {
			...reason,
			triggerId
		}, [triggerId]);
	}
	/** Start the Evals in progress again under the new Policy version, and say that it changed. */
	policyChanged(from, to) {
		for (const thread of this.repo.threads.active()) if (thread.evaluating) this.reassess(thread, { code: "policyChanged" });
		this.emit("policy.changed", {
			from,
			to
		});
	}
	/** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
	reassess(thread, reason, without = []) {
		const ids = thread.evaluating.triggerIds.filter((id) => !without.includes(id));
		const decision = this.finish(thread, thread.evaluating, {
			kind: "unavailable",
			reason: [reason]
		});
		const current = this.repo.threads.get(thread.key);
		current.pending = [...ids, ...current.pending.filter((id) => !ids.includes(id))];
		this.repo.threads.save(current);
		return decision;
	}
	/** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
	holding(triggerId) {
		const trigger = this.repo.triggers.get(triggerId);
		const thread = trigger && this.repo.threads.get(threadKey(trigger.threads[0]));
		return thread?.evaluating?.triggerIds.includes(triggerId) ? thread : void 0;
	}
	candidateOf(thread) {
		const evaluation = thread.evaluating;
		const triggers = evaluation.triggerIds.flatMap((id) => {
			const trigger = this.repo.triggers.get(id);
			return trigger ? [trigger] : [];
		});
		const { id: evalId, strength, policyVersion } = evaluation;
		return {
			evalId,
			thread,
			triggers,
			strength,
			policyVersion,
			tickets: this.ticketsOnThread(thread)
		};
	}
	/**
	* Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
	* differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
	*/
	ignore(thread, ids, reason, policy, at) {
		const evaluation = {
			id: key("eval", thread.key, "ignored", policy.version, at, ...ids),
			threadKey: thread.key,
			triggerIds: ids,
			strength: "inferred",
			actor: {
				source: thread.ref.source,
				id: ""
			},
			basis: { via: "followup" },
			policyVersion: policy.version,
			startedAt: at,
			deadline: at
		};
		this.record(thread, evaluation, {
			kind: "ignore",
			reason
		});
		thread.pending = thread.pending.filter((id) => !ids.includes(id));
		delete thread.expired;
	}
	/**
	* The accept Decisions of the Triggers whose primary Thread is `threadKey`, by Trigger: what each one started. An Eval and
	* its Decision run on its Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
	*/
	accepted(threadKey) {
		const accepted = /* @__PURE__ */ new Map();
		for (const decision of this.repo.decisions.byThread(threadKey)) {
			if (decision.kind !== "accept" || !decision.ticketId) continue;
			for (const id of decision.triggerIds) if (!accepted.has(id)) accepted.set(id, decision);
		}
		return accepted;
	}
	/**
	* A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
	* ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
	* Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
	*/
	directEval(thread, trigger, kind, ticketId) {
		const policy = this.policy();
		const gate = policy.gate(trigger, thread, this.ticketsOnThread(thread));
		if (!gate.admissible) throw new UserError("notAdmissible", { reason: gate.reason });
		const at = this.now();
		if (thread.pending.includes(trigger.id)) {
			thread.pending = thread.pending.filter((id) => id !== trigger.id);
			this.repo.threads.save(thread);
		}
		return {
			id: key("eval", thread.key, "direct", trigger.id, kind, ...ticketId ? [ticketId] : [], at),
			threadKey: thread.key,
			triggerIds: [trigger.id],
			primary: trigger.id,
			strength: gate.strength,
			actor: trigger.actor,
			basis: gate.basis,
			policyVersion: policy.version,
			startedAt: at,
			deadline: at
		};
	}
	/** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
	decideEval(thread, evaluation, outcome) {
		const audit = outcome.audit ? { audit: outcome.audit } : {};
		if (this.policy().version !== evaluation.policyVersion) {
			if (thread.evaluating?.id === evaluation.id) return this.reassess(thread, { code: "policyChanged" });
			return this.finish(thread, evaluation, {
				kind: "unavailable",
				reason: [{ code: "policyChanged" }],
				...audit
			});
		}
		const unassessed = outcome.kind === "ignore" && evaluation.strength !== "explicit" && !outcome.audit ? [{ code: "ignoredFromCard" }] : [];
		if (outcome.kind === "ignore" || outcome.kind === "unavailable") return this.finish(thread, evaluation, {
			kind: outcome.kind,
			reason: [...unassessed, ...reasonOf(outcome.reason)],
			...audit
		});
		if (outcome.kind === "stop") {
			const ticket = this.repo.tickets.get(outcome.ticketId);
			if (!ticket || !liveTicket(ticket)) return this.finish(thread, evaluation, {
				kind: "ignore",
				reason: [{ code: "stopUnknown" }],
				...audit
			});
			if (evaluation.strength !== "explicit") return this.finish(thread, evaluation, {
				kind: "ignore",
				reason: [{ code: "stopNotExplicit" }],
				...audit
			});
			const decision = this.finish(thread, evaluation, {
				kind: "stop",
				reason: reasonOf(outcome.reason),
				ticketId: ticket.id,
				...audit
			});
			this.tickets.end(ticket.id, "human", "stopped", this.now(), typeof outcome.reason === "string" ? outcome.reason : void 0);
			return decision;
		}
		return this.accept(thread, evaluation, outcome);
	}
	/** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
	accept(thread, evaluation, outcome) {
		const at = this.now();
		const basis = {
			...evaluation.basis,
			...outcome.rules ? { rules: outcome.rules } : {}
		};
		const { strength, policyVersion, actor } = evaluation;
		const mandate = {
			strength,
			policyVersion,
			basis,
			actor,
			scope: outcome.scope
		};
		const ticketId = key("ticket", evaluation.id);
		const audit = outcome.audit ? { audit: outcome.audit } : {};
		const decision = this.finish(thread, evaluation, {
			kind: "accept",
			reason: reasonOf(outcome.reason),
			...audit,
			mandate,
			ticketId
		});
		this.tickets.create(ticketId, decision.id, mandate, evaluation, outcome, at);
		return decision;
	}
	/** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
	finish(thread, evaluation, outcome) {
		const decision = this.record(thread, evaluation, outcome);
		if (thread.evaluating?.id !== evaluation.id) return decision;
		delete thread.evaluating;
		delete thread.expired;
		this.repo.threads.save(thread);
		this.options.assessor.release?.(evaluation.id);
		return decision;
	}
	record(thread, evaluation, outcome) {
		const at = this.now();
		const decision = {
			id: key("decision", evaluation.id),
			evalId: evaluation.id,
			threadKey: thread.key,
			triggerIds: evaluation.triggerIds,
			policyVersion: evaluation.policyVersion,
			at,
			kind: outcome.kind,
			reason: outcome.reason,
			strength: evaluation.strength,
			...outcome.ticketId ? { ticketId: outcome.ticketId } : {},
			...outcome.mandate ? { mandate: outcome.mandate } : {},
			...outcome.audit ? { audit: outcome.audit } : {}
		};
		this.repo.decisions.save(decision);
		for (const id of evaluation.triggerIds) {
			const disposition = this.repo.triggers.disposition(id) ?? {
				fanout: [],
				at
			};
			this.repo.triggers.saveDisposition(id, {
				...disposition,
				evalId: evaluation.id,
				decisionId: decision.id
			});
		}
		this.emit("decision.recorded", {
			decisionId: decision.id,
			kind: decision.kind,
			threadKey: thread.key
		});
		return decision;
	}
};
//#endregion
//#region src/core/intake.ts
/** Trigger ingestion, thread correlation, subscription fan-out, and evaluation queuing. */
/**
* Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
* Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
* ticket's worker decides (see `followupOwners`).
* Engine delegates trigger reception to this part.
*/
var Intake = class extends EnginePart {
	tickets;
	constructor(options, tickets) {
		super(options);
		this.tickets = tickets;
	}
	receive(received) {
		const trigger = {
			...received,
			at: isoTime(received.at)
		};
		if (!trigger.threads.length) throw new Error("A trigger must belong to at least one thread");
		if (this.repo.triggers.get(trigger.id)) return "duplicate";
		const at = this.now();
		const filter = this.options.scope.scope(trigger);
		if (!filter.listened) {
			this.repo.triggers.save(trigger);
			this.repo.triggers.saveDisposition(trigger.id, {
				filtered: { code: filter.reason },
				fanout: [],
				at
			});
			return "filtered";
		}
		this.repo.triggers.save(trigger);
		const keys = trigger.threads.map(threadKey);
		const reached = /* @__PURE__ */ new Map();
		for (const ref of trigger.threads) {
			const thread = this.thread(ref);
			if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at;
			thread.correlated = [.../* @__PURE__ */ new Set([...thread.correlated, ...keys.filter((other) => other !== thread.key)])];
			for (const ticketId of thread.subscriptions) {
				const ticket = this.repo.tickets.get(ticketId);
				const followed = !!thread.context?.includes(ticketId);
				const resumes = trigger.human && ticket?.ended?.by !== "human" && !followed;
				if (!ticket || !liveTicket(ticket) && !resumes) continue;
				reached.set(ticketId, {
					ticket,
					context: followed && (reached.get(ticketId)?.context ?? true)
				});
			}
			this.repo.threads.save(thread);
		}
		for (const [ticketId, { ticket, context: followed }] of reached) this.tickets.addInput(ticket, {
			id: key("input", ticketId, "trigger", trigger.id),
			kind: "trigger",
			triggerId: trigger.id,
			at,
			...trigger.human ? { human: true } : {},
			...followed ? { context: true } : {}
		});
		const fanout = [...reached.keys()], context = fanout.filter((id) => reached.get(id).context);
		const disposition = {
			fanout,
			...context.length ? { context } : {},
			at
		};
		this.repo.triggers.saveDisposition(trigger.id, disposition);
		if (!this.owners(trigger).length) this.queueForEval(trigger);
		for (const ticketId of fanout) this.tickets.wake(ticketId);
		this.emit("trigger.received", {
			triggerId: trigger.id,
			threads: trigger.threads.map(threadKey)
		});
		return "stored";
	}
};
//#endregion
//#region src/core/replies.ts
/** The Engine's messages to Channels, each by the rule that allows it. */
/**
* Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
* question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
* that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
* an accept carries, and Assignments asks it to withdraw a question a report replaced.
*/
var Replies = class extends EnginePart {
	/**
	* Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
	* written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
	* result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
	* `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
	* records that the ticket's worker took the message up.
	* @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
	* that is not ready, completed, merged, or dropped.
	*/
	reply(request) {
		return request.purpose === "acknowledgement" ? this.acknowledge(request) : this.answer(request);
	}
	/**
	* Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
	* and a person wrote it.
	*/
	acknowledgeAccepted(ticketId, trigger, text) {
		if (trigger.channel && trigger.human) this.options.outbox.send({
			id: key("ack", trigger.id),
			channel: trigger.channel,
			text,
			kind: "acknowledgement",
			ticketId
		});
	}
	/** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
	withdrawAttention(attentionId) {
		this.options.outbox.withdraw(key("attention-reply", attentionId));
	}
	acknowledge(request) {
		const ticket = this.require(request.ticketId);
		if (!liveTicket(ticket)) throw new UserError("ackEnded");
		const trigger = this.repo.triggers.get(request.triggerId);
		if (!trigger) throw new UserError("unknownTrigger");
		if (!this.reaches(ticket, trigger, false)) throw new UserError("notReached");
		if (!trigger.channel) throw new UserError("ackNoChannel");
		const id = key("ack", trigger.id);
		const existing = this.options.outbox.status(id);
		if (!existing && !trigger.human) throw new UserError("ackNotPerson");
		if (!existing) this.options.outbox.send({
			id,
			channel: trigger.channel,
			text: request.text,
			kind: "acknowledgement",
			ticketId: ticket.id
		});
		this.takeUp(ticket.id, trigger.id);
		return {
			id,
			status: this.options.outbox.status(id) ?? "pending",
			reused: existing !== void 0
		};
	}
	answer(request) {
		const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : void 0;
		if (request.triggerId && !trigger) throw new UserError("unknownTrigger");
		const ticket = request.ticketId ? this.require(request.ticketId) : trigger ? this.repo.tickets.list().find((item) => this.reaches(item, trigger)) : void 0;
		if (request.purpose === "result") {
			const outcome = ticket && ticketOutcome(ticket);
			const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === "ready";
			if (!ticket || !(outcome === "merged" || outcome === "completed" || outcome === "dropped" || reported)) throw new UserError("notReady");
		}
		const attention = request.purpose === "attention" ? ticket?.attention : void 0;
		if (request.purpose === "attention" && (!attention || attention.question !== request.question)) throw new UserError("notAttention");
		if (request.purpose === "answer" && !trigger?.human) throw new UserError("notQuestion");
		const id = attention ? key("attention-reply", attention.id) : key("reply", trigger?.id ?? ticket?.id ?? "", request.text);
		const existing = this.options.outbox.status(id);
		const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id);
		if (request.purpose === "answer" && !ready && !existing) throw new UserError("noAnswer");
		const asker = attention?.triggerId ? this.repo.triggers.get(attention.triggerId) : void 0;
		const channel = request.purpose === "answer" ? trigger.channel : asker?.channel ?? (ticket ? this.sourceChannel(ticket) : void 0);
		if (!channel) throw new UserError("noChannel");
		this.options.outbox.send({
			id,
			channel,
			text: request.text,
			kind: "reply",
			...ticket ? { ticketId: ticket.id } : {}
		});
		if (request.purpose === "answer" && ticket && trigger && ticket.answers?.includes(trigger.id)) {
			ticket.answers = ticket.answers.filter((item) => item !== trigger.id);
			this.repo.tickets.save(ticket);
		}
		return {
			id,
			status: this.options.outbox.status(id) ?? "pending",
			reused: existing !== void 0
		};
	}
	/** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
	sourceChannel(ticket) {
		return this.source(ticket)?.channel ?? ticket.channels[0];
	}
};
//#endregion
//#region src/core/engine.ts
/** The domain Engine: the single entry point of the core, and the role interfaces its callers receive. */
/**
* Single transactional entry point for mutating Triggers, Threads, Decisions, Tickets, and Assignments.
* Coordinates Intake, Evals, Tickets, Assignments, and Replies inside synchronous repository transactions while queuing side
* effects through ports. Callers receive role-scoped `Pick` interfaces rather than the full engine.
*/
var Engine = class {
	options;
	repo;
	replies;
	tickets;
	assignments;
	evals;
	intake;
	constructor(options) {
		this.options = options;
		this.repo = options.repo;
		this.replies = new Replies(options);
		this.tickets = new Tickets(options, this.replies);
		this.assignments = new Assignments(options, this.tickets, this.replies);
		this.evals = new Evals(options, this.tickets);
		this.intake = new Intake(options, this.tickets);
	}
	/**
	* A Source's request to take in a Trigger: store it once, fan it out to the tickets that subscribe to its Threads (to an
	* ended one only a person's message, which resumes it at once unless processing is paused, and to none a person stopped),
	* and queue it for Eval on its primary Thread unless a ticket's worker decides it (see `followupOwners`).
	* Triggers that arrive while an Eval of that Thread runs wait together for the next one.
	*/
	receive(trigger) {
		return this.repo.atomic(() => this.intake.receive(trigger));
	}
	/**
	* A Source's request to make an open ticket follow one of its Threads, such as a pull request's, `own` when the ticket
	* opened it: the ticket subscribes to it, and a ready report ends it only once `followsDone` holds (see `Tickets.followsDone`).
	* @throws UserError when the ticket is unknown or has ended.
	*/
	bindThread(ticketId, thread, own) {
		return this.repo.atomic(() => this.tickets.bind(ticketId, thread, own));
	}
	/**
	* A Source's fact that a Thread closed, such as its pull request's merge, at the time it happened. An open ticket that
	* follows it ends once it is done with the Threads it follows, unless work resumed since the close has not finished, or
	* its worker took up a person's message the ticket decides after its latest report.
	*/
	threadClosed(thread, outcome, at) {
		this.repo.atomic(() => {
			this.tickets.threadClosed(thread, outcome, isoTime(at));
		});
	}
	/**
	* Requeues overdue Evals up to `REQUEUES` times before recording `unavailable` (undelivered Evals never expire), starts the
	* Evals of Threads whose queued Triggers wait, and resumes ended tickets a person's message reached while processing was
	* paused. While processing is paused, nothing expires: each Eval in progress notes when the pause began, and its deadline
	* moves forward by the pause's length once processing resumes. Each Eval and each ticket update takes one transaction.
	*/
	evaluateDue() {
		const policy = this.options.policy();
		for (const thread of this.repo.threads.active()) if (thread.evaluating) this.repo.atomic(() => {
			this.evals.due(thread, policy);
		});
		if (policy.paused) return;
		for (const ticket of this.repo.tickets.active()) if (!liveTicket(ticket) && ticket.undelivered.length) this.repo.atomic(() => {
			this.tickets.wake(ticket.id);
		});
		for (const thread of this.repo.threads.active()) if (thread.pending.length && !thread.evaluating) this.repo.atomic(() => {
			this.evals.start(thread.key, policy);
		});
	}
	/** The candidate of the Eval that holds a Trigger, as its assessor sees it; undefined while no Eval holds it. */
	candidate(triggerId) {
		return this.evals.candidate(triggerId);
	}
	/**
	* Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does, such as a person's explicit
	* request the main Session routes. A proactive candidate is accepted only in `auto` mode with enabled rules its assessment
	* matched, and a Trigger that already started a ticket returns that ticket's Decision. An invalid stop is recorded as
	* `ignore`; one judged under an older Policy as `unavailable`.
	* @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
	* ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
	* mode or without enabled matching rules.
	*/
	decide(triggerId, outcome) {
		return this.repo.atomic(() => this.evals.decide(triggerId, outcome));
	}
	/**
	* Attach a Trigger to a ticket that the message points at: the ticket follows the Trigger's Threads and receives it as an
	* Input with the routing note, and the Eval that holds the Trigger ends, since the ticket has it now; the other Triggers of
	* its batch wait for a fresh Eval. A note for an Input the worker already received goes out as a new Input, and so does a
	* message the ticket let go, read for context only, or had before it ended. An ended ticket resumes under its Mandate, at
	* once unless processing is paused.
	* @throws UserError for a ticket a person stopped, which withdrew its Mandate, or one whose Mandate the Policy no longer holds.
	*/
	attach(ticketId, triggerId, note) {
		return this.repo.atomic(() => {
			if (this.repo.triggers.disposition(triggerId)?.handbacks?.some((item) => item.ticketId === ticketId)) throw new UserError("handedBackHere");
			const trigger = this.tickets.attachable(ticketId, triggerId);
			this.evals.withdraw(trigger);
			this.tickets.attach(ticketId, trigger, note);
			this.evals.routed(triggerId, ticketId);
			this.tickets.wake(ticketId);
			return this.repo.tickets.get(ticketId);
		});
	}
	/**
	* Ask a running worker that waits in `waiting` state for its status; any other worker is left alone.
	* @returns whether the worker was asked.
	* @throws UserError when the ticket is unknown.
	*/
	requestStatus(ticketId) {
		return this.repo.atomic(() => this.tickets.requestStatus(ticketId));
	}
	/**
	* Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where the person's message was
	* written, attention where the message that raised the question was, else, like a result, to the conversation the ticket
	* started in. A message queued before is not queued again (see `Replies.reply`).
	* @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket that
	* is not ready, completed, merged, or dropped.
	*/
	reply(request) {
		return this.repo.atomic(() => this.replies.reply(request));
	}
	/** The assessor delivered an Eval's candidate to its Session: the Eval's deadline counts from now. */
	candidateDelivered(evalId) {
		this.repo.atomic(() => {
			this.evals.delivered(evalId, this.options.policy());
		});
	}
	/**
	* Queue a stored Trigger for a fresh Eval, such as a person's replay; returns false while an Eval holds it.
	* @throws UserError when the trigger is unknown.
	*/
	reevaluate(triggerId) {
		return this.repo.atomic(() => this.evals.reevaluate(triggerId));
	}
	/**
	* A person dismisses the problem an unavailable Decision shows: the overview lists it no more.
	* @throws UserError for a Decision that is unknown or not unavailable.
	*/
	dismiss(decisionId) {
		return this.repo.atomic(() => this.evals.dismiss(decisionId));
	}
	/**
	* Drop every ticket's Subscription to a Thread, until a new Decision subscribes one again.
	* @returns whether a Subscription was dropped.
	*/
	unsubscribe(thread) {
		return this.repo.atomic(() => this.tickets.dropSubscriptions(thread, "person"));
	}
	/**
	* A person stops a ticket, which withdraws its Mandate: it ends and receives nothing more.
	* @throws UserError when the ticket is unknown.
	*/
	stopTicket(ticketId, reason) {
		return this.repo.atomic(() => this.tickets.stop(ticketId, reason));
	}
	/**
	* A person retries a ticket whose worker reported failed or blocked (or whose input delivery failed): the stalled
	* Assignment ends and a new one starts under the same Mandate.
	* @throws UserError when the ticket is unknown, has ended, or is not retryable.
	*/
	retryTicket(ticketId) {
		return this.repo.atomic(() => this.tickets.retry(ticketId));
	}
	/**
	* The Executor's fact that an Assignment runs; the Inputs that wait for it go out.
	* @throws UserError when the ticket is unknown.
	*/
	assignmentStarted(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.started(ticketId, assignmentId);
		});
	}
	/**
	* The Executor's fact that Inputs reached the Assignment that runs the ticket, which clears a failed delivery. A fact about
	* an Assignment that no longer runs is dropped. Its worker reads each once its Session takes it into a step (`inputsRead`).
	*/
	inputsDelivered(ticketId, assignmentId, inputIds) {
		this.repo.atomic(() => {
			this.assignments.delivered(ticketId, assignmentId, inputIds);
		});
	}
	/**
	* The Executor's fact that the worker's Session of an open ticket took the messages that carried Inputs into a step, from
	* which its model reads them: a report or the end of a turn after that counts them as read at the ticket's end.
	* @throws UserError when the ticket is unknown.
	*/
	inputsRead(ticketId, inputIds) {
		this.repo.atomic(() => {
			this.assignments.read(ticketId, inputIds);
		});
	}
	/** The Executor's fact that a turn of the worker of the Assignment that runs the ticket ended, after a report too. */
	turnEnded(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.turnEnded(ticketId, assignmentId);
		});
	}
	/** The Executor's fact that delivering Inputs to the Assignment that runs the ticket failed; the ticket shows it until a delivery succeeds. */
	deliveryFailed(ticketId, assignmentId, error) {
		this.repo.atomic(() => {
			this.assignments.deliveryFailed(ticketId, assignmentId, error);
		});
	}
	/**
	* A worker's request, through its Executor, to mark a Thread attached to its ticket unrelated, for `reason`: only that
	* ticket's Subscription drops, until a new Decision subscribes it again.
	* @throws UserError when the ticket is unknown, or for the Thread the ticket started on, one a Source bound it to (such as
	* its pull request's), or one it does not follow.
	*/
	markUnrelated(ticketId, thread, reason) {
		this.repo.atomic(() => {
			this.tickets.markUnrelated(ticketId, thread, reason);
		});
	}
	/**
	* An Executor's Subscription to a Thread it found related, for context: see `Tickets.followForContext` and `Thread.context`.
	* @returns false when the ticket already follows the Thread.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	followForContext(ticketId, thread) {
		return this.repo.atomic(() => this.tickets.followForContext(ticketId, thread));
	}
	/**
	* A fact the main Session gives an open ticket's Executor: see `Tickets.note`.
	* @throws UserError when the ticket is unknown or has ended.
	*/
	note(ticketId, text) {
		return this.repo.atomic(() => this.tickets.note(ticketId, text));
	}
	/**
	* An Executor's hand-back of a message that reached its ticket but asks for more than it: see `Evals.handback`.
	* @returns whether it was queued for Eval: false while another ticket still decides it, and for one this ticket did not decide (see `Evals.handback`).
	* @throws UserError when the ticket or trigger is unknown, the trigger did not reach the ticket, or the ticket already handed it back.
	*/
	handback(ticketId, triggerId, reason) {
		return this.repo.atomic(() => this.evals.handback(ticketId, triggerId, reason));
	}
	/**
	* Record a report on an open ticket's current Assignment. Its question for a person (`attention`) is asked, kept, or
	* cleared (`null` or a `ready` report), and a replaced attention question whose reply has not been sent yet is withdrawn
	* from the outbox. A `blocked` or `failed` report holds back automated inputs until a human message arrives. A `dropped`
	* report ends the ticket, and a `ready` report ends it: `completed` without followed Threads, else with the `followsDone`
	* outcome once `followsDone` holds.
	* @throws UserError for an unknown or ended ticket, an ended assignment, a question that comes with a ready result or an
	* answer, or a question or answer that names a message that is not a person's or did not reach the ticket.
	*/
	report(ticketId, report) {
		return this.repo.atomic(() => this.assignments.report(ticketId, report));
	}
	/**
	* Handles an assignment that was running when the host stopped: restarts it with a recovery note unless its latest report is
	* `waiting`, `ready`, `blocked`, or `failed` and no Input reached its worker after that report, in which case it keeps its
	* Session and state and gets the Inputs that wait for it.
	*/
	assignmentInterrupted(ticketId, assignmentId) {
		this.repo.atomic(() => {
			this.assignments.interrupted(ticketId, assignmentId);
		});
	}
	/**
	* The Policy changed: each open ticket in `effects` is told how the change bears on it, and Evals in progress start again
	* under the new version.
	*/
	policyChanged(from, to, effects = /* @__PURE__ */ new Map()) {
		this.repo.atomic(() => {
			this.tickets.policyChanged(from, to, effects);
			this.evals.policyChanged(from, to);
		});
	}
};
//#endregion
//#region src/local-preset-message.ts
const MessageId = (id) => id;
function freezeMessage(message) {
	const copy = structuredClone(message);
	const freeze = (value) => {
		if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	};
	freeze(copy);
	return copy;
}
//#endregion
//#region \0@oxc-project+runtime@0.148.0/helpers/esm/usingCtx.js
function _usingCtx() {
	var r = "function" == typeof SuppressedError ? SuppressedError : function(r, e) {
		var n = Error();
		return n.name = "SuppressedError", n.error = r, n.suppressed = e, n;
	}, e = {}, n = [];
	function using(r, e) {
		if (null != e) {
			if (Object(e) !== e) throw new TypeError("using declarations can only be used with objects, functions, null, or undefined.");
			if (r) var o = e[Symbol.asyncDispose || Symbol["for"]("Symbol.asyncDispose")];
			if (void 0 === o && (o = e[Symbol.dispose || Symbol["for"]("Symbol.dispose")], r)) var t = o;
			if ("function" != typeof o) throw new TypeError("Object is not disposable.");
			t && (o = function o() {
				try {
					t.call(e);
				} catch (r) {
					return Promise.reject(r);
				}
			}), n.push({
				v: e,
				d: o,
				a: r
			});
		} else r && n.push({
			d: e,
			a: r
		});
		return e;
	}
	return {
		e,
		u: using.bind(null, !1),
		a: using.bind(null, !0),
		d: function d() {
			var o, t = this.e, s = 0;
			function next() {
				for (; o = n.pop();) try {
					if (!o.a && 1 === s) return s = 0, n.push(o), Promise.resolve().then(next);
					if (o.d) {
						var r = o.d.call(o.v);
						if (o.a) return s |= 2, Promise.resolve(r).then(next, err);
					} else s |= 1;
				} catch (r) {
					return err(r);
				}
				if (1 === s) return t !== e ? Promise.reject(t) : Promise.resolve();
				if (t !== e) throw t;
			}
			function err(n) {
				return t = t !== e ? new r(n, t) : n, next();
			}
			return next();
		}
	};
}
//#endregion
//#region src/app/delivery.ts
/** The id of the message delivered under `requestId`, the same on every retry. */
const messageId = (requestId) => MessageId(`dsh-superagent:${requestId}`);
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message) {
	const source = message.source;
	if (source.kind === "dsh-superagent" || source.kind === "plugin" && source.plugin === "dsh-superagent") return message.id;
	if (source.kind === "user" && "rpcId" in source && typeof source.rpcId === "string") return messageId(source.rpcId);
}
/**
* Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
* Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
* and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
*/
var AgentDelivery = class {
	ctx;
	seen = /* @__PURE__ */ new WeakMap();
	constructor(ctx) {
		this.ctx = ctx;
		ctx.on("session/event", (session, event) => {
			if (event.type !== "user/message") return;
			const id = deliveryId(event.data);
			if (id) this.seen.get(session)?.ids.add(id);
		});
	}
	async history(agent) {
		let seen = this.seen.get(agent.session);
		if (!seen) {
			seen = { ids: /* @__PURE__ */ new Set() };
			this.seen.set(agent.session, seen);
		}
		const state = seen;
		state.loaded ??= (async () => {
			try {
				var _usingCtx$1 = _usingCtx();
				await this.ctx.sessionPersistence.flush();
				const handle = _usingCtx$1.a(await this.ctx.sessionPersistence.open(agent.id, "read"));
				for (let offset = 0;;) {
					const { events } = await handle.read(offset, 512);
					if (!events.length) break;
					for (const event of events) {
						if (event.type !== "user/message") continue;
						const id = deliveryId(event.data);
						if (id) state.ids.add(id);
					}
					offset += events.length;
				}
			} catch (_) {
				_usingCtx$1.e = _;
			} finally {
				await _usingCtx$1.d();
			}
		})().catch((error) => {
			state.loaded = void 0;
			throw error;
		});
		await state.loaded;
		return state;
	}
	async holds(agent, requestId) {
		const id = messageId(requestId);
		return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => deliveryId(message) === id);
	}
	/** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
	async send(agent, requestId, text, mode, signal, authorize, accepted) {
		signal.throwIfAborted();
		const seen = await this.history(agent);
		signal.throwIfAborted();
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error("Delivery target was disposed");
		authorize?.();
		const id = messageId(requestId);
		const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some((message) => deliveryId(message) === id);
		if (!seen.ids.has(id) && !pending) {
			const source = typeof mode === "object" ? {
				kind: "dsh-superagent",
				form: "notice",
				summary: mode.inject
			} : {
				kind: "dsh-superagent",
				form: "relay"
			};
			const message = freezeMessage({
				id,
				role: "user",
				content: [{
					type: "text",
					text
				}],
				source
			});
			if (typeof mode === "object") {
				agent.inject(message);
				seen.ids.add(id);
			} else if (mode === "steer") agent.steer(message);
			else agent.followup(message);
		}
		accepted?.();
		await this.ctx.sessionPersistence.flush();
	}
};
//#endregion
//#region src/app/effects.ts
/**
* Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
* Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
*/
var Later = class extends Error {};
/**
* Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
* Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
*/
var Effects = class {
	store;
	board;
	now;
	handlers = /* @__PURE__ */ new Map();
	health = /* @__PURE__ */ new Map();
	tasks = /* @__PURE__ */ new Set();
	/** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
	broken = /* @__PURE__ */ new Set();
	seq;
	scheduled = false;
	/** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
	started = false;
	stopped = false;
	constructor(store, board, now = () => Date.now()) {
		this.store = store;
		this.board = board;
		this.now = now;
		this.seq = Number(store.db.prepare("SELECT IFNULL(MAX(seq), 0) AS seq FROM effect").get()?.seq ?? 0);
	}
	/** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
	enqueue(kind, key, payload) {
		this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`).run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString());
		this.kick();
	}
	handle(kind, run, options = {}) {
		if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`);
		this.health.set(kind, this.board.claim(kind));
		const { limit = () => 1, retry = [2e3, 6e4], ordered = false, quiet = false } = options;
		this.handlers.set(kind, {
			run,
			limit: ordered ? () => Math.min(1, limit()) : limit,
			retry,
			ordered,
			quiet
		});
		this.report(kind);
		this.kick();
	}
	pending(kind, key) {
		return key === void 0 ? !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? LIMIT 1").get(kind) : !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? AND key = ?").get(kind, key);
	}
	/** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
	cancel(kind, key) {
		this.store.db.prepare("DELETE FROM effect WHERE kind = ? AND key = ?").run(kind, key);
		this.store.afterCommit(() => {
			this.report(kind);
		});
	}
	start() {
		this.started = true;
		this.kick();
	}
	kick() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.dispatch();
		});
	}
	/** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
	async idle(kind) {
		for (;;) {
			this.dispatch();
			const running = [...this.tasks].filter((task) => kind === void 0 || task.kind === kind).map((task) => task.done);
			if (!running.length) return;
			await Promise.allSettled(running);
		}
	}
	/** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
	async drain() {
		this.stopped = true;
		await Promise.allSettled([...this.tasks].map((task) => task.done));
	}
	dispatch() {
		if (!this.started || this.stopped) return;
		for (const [kind, handler] of this.handlers) try {
			const running = new Set([...this.tasks].filter((task) => task.kind === kind).map((task) => task.key));
			const rows = handler.ordered ? this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1").all(kind) : this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?").all(kind, this.now(), 16 + running.size);
			const ready = handler.ordered && running.size ? [] : rows.filter((row) => row.due <= this.now() && !running.has(row.key));
			let room = ready.length ? handler.limit() - running.size : 0;
			for (const row of ready) {
				if (room-- <= 0) break;
				this.run(kind, handler, row);
			}
			if (this.broken.delete(kind)) this.report(kind);
		} catch (error) {
			this.failed(kind, error);
		}
	}
	run(kind, handler, row) {
		const task = {
			kind,
			key: row.key,
			done: Promise.resolve()
		};
		task.done = this.attempt(kind, handler, row).catch((error) => {
			this.failed(kind, error);
		}).finally(() => {
			this.tasks.delete(task);
			this.kick();
		});
		this.tasks.add(task);
	}
	async attempt(kind, handler, row) {
		let failure;
		try {
			await handler.run(JSON.parse(row.value), row.key);
		} catch (error) {
			failure = { error };
		}
		const own = "kind = ? AND key = ? AND seq = ? AND generation = ?", ownRow = [
			kind,
			row.key,
			row.seq,
			row.generation
		];
		if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow);
		else if (this.stopped) return;
		else if (failure.error instanceof Later) this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow);
		else {
			const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16));
			this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`).run(String(failure.error).slice(0, 1e3), this.now() + delay, ...ownRow);
		}
		if (!this.stopped) this.report(kind);
	}
	failed(kind, error) {
		this.broken.add(kind);
		this.health.get(kind)?.set({
			state: "error",
			detail: `The effect queue failed: ${String(error)}`,
			at: new Date(this.now()).toISOString()
		});
	}
	report(kind) {
		const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind);
		const waiting = Number(row?.waiting ?? 0);
		const failing = Number(row?.attempts ?? 0) >= 3 && !this.handlers.get(kind)?.quiet;
		const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : "Nothing waiting";
		this.health.get(kind)?.set(failing ? {
			state: "error",
			detail: `${detail}; the last failure: ${String(row?.error)}`,
			at: new Date(this.now()).toISOString()
		} : {
			state: "ready",
			detail,
			at: new Date(this.now()).toISOString()
		});
	}
};
//#endregion
//#region src/kv.ts
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
const record$1 = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
function family(prefix, format = (...name) => name.join(":")) {
	return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
const KV = {
	/** Store: current database schema version. */
	store: { schema: record$1("schema") },
	/** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
	settings: {
		revision: record$1("settings-revision"),
		block: family("settings-block-revision:"),
		version: family("settings-version:")
	},
	/** Prompts: current revision and saved prompt versions. */
	prompts: {
		revision: record$1("prompt-revision"),
		version: family("prompt-version:"),
		/** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
		builtIn: family("prompt-built-in:")
	},
	/** Runtime: the main Session's ID. */
	runtime: { masterId: record$1("master-id") },
	/** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
	sessions: { prompts: family("session-prompts:") },
	/** Schema 11 migration: legacy main-Session queues imported into the effect table. */
	queues: {
		relays: record$1("relay-queue"),
		unsubscribed: record$1("subscription-results"),
		prompts: record$1("prompt-notification"),
		settings: record$1("settings-notification")
	},
	/** Per-Source resolved display names mapping a named ID (such as a Feishu chat ID) to its display name. */
	sources: { labels: family("source-labels:") },
	/**
	* GitHub Source: notification cursor and pending retries; per-Issue/PR read cursor shared by notification and polled reads;
	* per-stream cursor, start times by kind, and ETag; default-branch CI state; and per-PR CI fingerprint and revision (`revision`
	* counts reported CI changes so each produces a distinct Trigger ID).
	*/
	github: {
		since: record$1("github-since"),
		retries: record$1("github-retry"),
		cursor: family("github-cursor:"),
		stream: family("github-stream:"),
		branchCi: record$1("github-branch-ci"),
		ci: family("github-ci:")
	},
	/**
	* Feishu Source: known chats (`true` for direct messages); per-chat history cursor and active topics mapped from topic ID
	* to last-seen timestamp; and per-polled-thread seen message IDs and initialization flag.
	*/
	feishu: {
		chats: record$1("feishu-chats"),
		history: family("feishu-history:"),
		topics: family("feishu-history-threads:"),
		seen: family("thread-seen:"),
		initialized: family("thread-initialized:")
	}
};
//#endregion
//#region src/limits.ts
/** Validation bounds shared between host schemas and management panel forms. */
const LIMITS = {
	ruleName: 100,
	ruleInstruction: 2e3,
	evalTimeoutSeconds: {
		min: 30,
		max: 600
	},
	maxWorkers: {
		min: 1,
		max: 16
	},
	prepareCommand: 4e3,
	promptMaxChars: {
		min: 1e3,
		max: 1e6
	},
	admissionContextMaxPages: {
		min: 1,
		max: 100
	},
	admissionContextTimeoutMs: {
		min: 1,
		max: 9e4
	}
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/core.js
var _a$1;
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
const globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
const EVALUATING = /* @__PURE__*/ Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
const propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
	rest.path ?? (rest.path = []);
	rest.message = message;
	if (ctx?.reportInput) rest.input = _input;
	return rest;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					if (!(i === fullpath.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/parse.js
const _parse = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parse(_Err)(schema, value, ctx);
};
const _decode = (_Err) => (schema, value, _ctx) => {
	return _parse(_Err)(schema, value, _ctx);
};
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const cuid = /^[cC][0-9a-z]{6,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const httpProtocol = /^https?$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/checks.js
const $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) {
			if (def.inclusive) bag.maximum = def.value;
			else bag.exclusiveMaximum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) {
			if (def.inclusive) bag.minimum = def.value;
			else bag.exclusiveMinimum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 4,
	patch: 3
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/schemas.js
const $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
const $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
const $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			if (!def.normalize && def.protocol?.source === httpProtocol.source) {
				if (!/^https?:\/\//i.test(trimmed)) {
					payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid URL format",
						input: payload.value,
						inst,
						continue: !def.abort
					});
					return;
				}
			}
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
	const isPresent = key in input;
	if (result.issues.length) {
		if (isOptionalIn && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && !isOptionalIn) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalIn = _catchall.optin === "optional";
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (key === "__proto__") continue;
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalIn = el._zod.optin === "optional";
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const schema = shape[key];
			const isOptionalIn = schema?._zod?.optin === "optional";
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalIn && isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values) {
			payload.value = {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized
			});
		} else {
			payload.value = {};
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
const $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		payload.fallback = true;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (input === void 0 && (result.issues.length || result.fallback)) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const input = payload.value;
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, input));
			return handleOptionalResult(result, input);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
				payload.fallback = true;
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
			payload.fallback = true;
		}
		return payload;
	};
});
const $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues,
		fallback: left.fallback
	}, ctx);
}
const $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry$1() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry$1());
const globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			defs[seen.defId] = seen.def;
		}
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/json-schema-processors.js
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) {
		if (legacy) {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	} else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) {
		if (legacy) {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	} else if (typeof maximum === "number") json.maximum = maximum;
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = keyType._zod.bag?.patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = process$1(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process$1(def.keyType, ctx, {
			...params,
			path: [...params.path, "propertyNames"]
		});
		json.additionalProperties = process$1(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	if (keyValues) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues;
	}
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/iso.js
const ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
const ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
const ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
const ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, { Parent: Error });
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/classic/schemas.js
const _installedGroups = /* @__PURE__ */ new WeakMap();
function _installLazyMethods(inst, group, methods) {
	const proto = Object.getPrototypeOf(inst);
	let installed = _installedGroups.get(proto);
	if (!installed) {
		installed = /* @__PURE__ */ new Set();
		_installedGroups.set(proto, installed);
	}
	if (installed.has(group)) return;
	installed.add(group);
	for (const key in methods) {
		const fn = methods[key];
		Object.defineProperty(proto, key, {
			configurable: true,
			enumerable: false,
			get() {
				const bound = fn.bind(this);
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: bound
				});
				return bound;
			},
			set(v) {
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: v
				});
			}
		});
	}
}
const ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	_installLazyMethods(inst, "ZodType", {
		check(...chks) {
			const def = this.def;
			return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
				check: ch,
				def: { check: "custom" },
				onattach: []
			} } : ch)] }), { parent: true });
		},
		with(...chks) {
			return this.check(...chks);
		},
		clone(def, params) {
			return clone(this, def, params);
		},
		brand() {
			return this;
		},
		register(reg, meta) {
			reg.add(this, meta);
			return this;
		},
		refine(check, params) {
			return this.check(refine(check, params));
		},
		superRefine(refinement, params) {
			return this.check(superRefine(refinement, params));
		},
		overwrite(fn) {
			return this.check(/* @__PURE__ */ _overwrite(fn));
		},
		optional() {
			return optional(this);
		},
		exactOptional() {
			return exactOptional(this);
		},
		nullable() {
			return nullable(this);
		},
		nullish() {
			return optional(nullable(this));
		},
		nonoptional(params) {
			return nonoptional(this, params);
		},
		array() {
			return array(this);
		},
		or(arg) {
			return union([this, arg]);
		},
		and(arg) {
			return intersection(this, arg);
		},
		transform(tx) {
			return pipe(this, transform(tx));
		},
		default(d) {
			return _default(this, d);
		},
		prefault(d) {
			return prefault(this, d);
		},
		catch(params) {
			return _catch(this, params);
		},
		pipe(target) {
			return pipe(this, target);
		},
		readonly() {
			return readonly(this);
		},
		describe(description) {
			const cl = this.clone();
			globalRegistry.add(cl, { description });
			return cl;
		},
		meta(...args) {
			if (args.length === 0) return globalRegistry.get(this);
			const cl = this.clone();
			globalRegistry.add(cl, args[0]);
			return cl;
		},
		isOptional() {
			return this.safeParse(void 0).success;
		},
		isNullable() {
			return this.safeParse(null).success;
		},
		apply(fn) {
			return fn(this);
		}
	});
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	return inst;
});
/** @internal */
const _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	_installLazyMethods(inst, "_ZodString", {
		regex(...args) {
			return this.check(/* @__PURE__ */ _regex(...args));
		},
		includes(...args) {
			return this.check(/* @__PURE__ */ _includes(...args));
		},
		startsWith(...args) {
			return this.check(/* @__PURE__ */ _startsWith(...args));
		},
		endsWith(...args) {
			return this.check(/* @__PURE__ */ _endsWith(...args));
		},
		min(...args) {
			return this.check(/* @__PURE__ */ _minLength(...args));
		},
		max(...args) {
			return this.check(/* @__PURE__ */ _maxLength(...args));
		},
		length(...args) {
			return this.check(/* @__PURE__ */ _length(...args));
		},
		nonempty(...args) {
			return this.check(/* @__PURE__ */ _minLength(1, ...args));
		},
		lowercase(params) {
			return this.check(/* @__PURE__ */ _lowercase(params));
		},
		uppercase(params) {
			return this.check(/* @__PURE__ */ _uppercase(params));
		},
		trim() {
			return this.check(/* @__PURE__ */ _trim());
		},
		normalize(...args) {
			return this.check(/* @__PURE__ */ _normalize(...args));
		},
		toLowerCase() {
			return this.check(/* @__PURE__ */ _toLowerCase());
		},
		toUpperCase() {
			return this.check(/* @__PURE__ */ _toUpperCase());
		},
		slugify() {
			return this.check(/* @__PURE__ */ _slugify());
		}
	});
});
const ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
	inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
	inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
const ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	_installLazyMethods(inst, "ZodNumber", {
		gt(value, params) {
			return this.check(/* @__PURE__ */ _gt(value, params));
		},
		gte(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		min(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		lt(value, params) {
			return this.check(/* @__PURE__ */ _lt(value, params));
		},
		lte(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		max(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		int(params) {
			return this.check(int(params));
		},
		safe(params) {
			return this.check(int(params));
		},
		positive(params) {
			return this.check(/* @__PURE__ */ _gt(0, params));
		},
		nonnegative(params) {
			return this.check(/* @__PURE__ */ _gte(0, params));
		},
		negative(params) {
			return this.check(/* @__PURE__ */ _lt(0, params));
		},
		nonpositive(params) {
			return this.check(/* @__PURE__ */ _lte(0, params));
		},
		multipleOf(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		step(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		finite() {
			return this;
		}
	});
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
const ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
const ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
const ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
const ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
const ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	_installLazyMethods(inst, "ZodArray", {
		min(n, params) {
			return this.check(/* @__PURE__ */ _minLength(n, params));
		},
		nonempty(params) {
			return this.check(/* @__PURE__ */ _minLength(1, params));
		},
		max(n, params) {
			return this.check(/* @__PURE__ */ _maxLength(n, params));
		},
		length(n, params) {
			return this.check(/* @__PURE__ */ _length(n, params));
		},
		unwrap() {
			return this.element;
		}
	});
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
const ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	_installLazyMethods(inst, "ZodObject", {
		keyof() {
			return _enum(Object.keys(this._zod.def.shape));
		},
		catchall(catchall) {
			return this.clone({
				...this._zod.def,
				catchall
			});
		},
		passthrough() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		loose() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		strict() {
			return this.clone({
				...this._zod.def,
				catchall: never()
			});
		},
		strip() {
			return this.clone({
				...this._zod.def,
				catchall: void 0
			});
		},
		extend(incoming) {
			return extend(this, incoming);
		},
		safeExtend(incoming) {
			return safeExtend(this, incoming);
		},
		merge(other) {
			return merge(this, other);
		},
		pick(mask) {
			return pick(this, mask);
		},
		omit(mask) {
			return omit(this, mask);
		},
		partial(...args) {
			return partial(ZodOptional, this, args[0]);
		},
		required(...args) {
			return required(ZodNonOptional, this, args[0]);
		}
	});
});
function object(shape, params) {
	const def = {
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	};
	return new ZodObject(def);
}
const ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
const ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
	return new ZodEnum({
		type: "enum",
		entries,
		...normalizeParams(params)
	});
}
const ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		payload.value = output;
		payload.fallback = true;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
new Intl.Segmenter("zh", { granularity: "word" });
promisify(execFile);
[
	"dsh-tag",
	"dsh-go",
	"dsh-freelancer"
].map((name) => `# Written by ${name} on every start; edits are lost.`);
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
const WORKER_COMMANDS = [
	"gh",
	"git",
	"lark-cli"
];
//#endregion
//#region src/policy.ts
/**
* Runtime settings schemas, assessment validation, and policy gate evaluation.
* Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
*/
const RuleIdSchema = string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
object({
	rule_id: RuleIdSchema,
	reason: string().trim().min(1).max(500)
}).strict().extend({ matched: boolean() }).strict();
object({
	implementation_requested: boolean(),
	target_basis: _enum([
		"specified",
		"existing-standard",
		"undetermined"
	]),
	requires_design_decision: boolean(),
	evidence: string().trim().min(1).max(700)
}).strict();
const DEFAULT_RULES = [{
	id: "copy",
	name: "Copy fixes",
	enabled: true,
	instruction: "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning."
}, {
	id: "visual",
	name: "Visual fixes",
	enabled: true,
	instruction: "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question."
}];
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
const RuleSchema = object({
	id: RuleIdSchema,
	name: string().trim().min(1).max(LIMITS.ruleName),
	enabled: boolean(),
	instruction: string().trim().min(1).max(LIMITS.ruleInstruction)
}).strict();
const RoleModelSchema = object({
	provider: string().trim().min(1),
	model: string().trim().min(1),
	reasoningEffort: string().trim().min(1).optional()
}).strict();
const AllowedSchema = object({
	id: string().trim().min(1).max(200),
	name: string().trim().max(100).optional()
}).strict();
const Weak = _enum(["inferred", "ignore"]);
const AdmissionRowSchema = object({
	listedUnaddressed: Weak.optional(),
	unlistedAddressed: _enum([
		"explicit",
		"inferred",
		"ignore"
	]).optional(),
	unlistedUnaddressed: Weak.optional()
}).strict();
const AdmissionTableSchema = record(string(), AdmissionRowSchema);
const SourcePolicySchema = object({
	allowed: array(AllowedSchema).default([]),
	admission: AdmissionTableSchema.default({})
}).catchall(unknown());
const PolicyConfigSchema = object({
	rules: array(RuleSchema).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Duplicate rule IDs").default(DEFAULT_RULES),
	sources: record(string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({})
}).strict();
const EvalConfigSchema = object({
	mode: _enum([
		"off",
		"observe",
		"auto"
	]).default("observe"),
	timeoutSeconds: number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
	model: RoleModelSchema.nullable().default(null)
}).strict();
const CommandNameSchema = string().regex(/^[A-Za-z0-9._-]+$/).refine((name) => name !== "." && name !== "..", "Not a command name").refine((name) => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(", ")} cannot be blocked`);
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, and blocked commands. */
const ExecutorConfigSchema = object({
	model: RoleModelSchema.nullable().default(null),
	maxWorkers: number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
	directory: string().trim().refine((path) => path === "" || path.startsWith("/"), "An absolute path, or empty for <stateDir>/work").default(""),
	prepare: string().max(LIMITS.prepareCommand).default(""),
	blockedCommands: array(CommandNameSchema).default([])
}).strict();
const SourceInstanceSchema = object({
	enabled: boolean().default(true),
	config: record(string(), unknown()).default({})
}).strict();
const SettingsSchema = object({
	paused: boolean().default(false),
	sources: record(string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
	policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
	eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
	executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({}))
}).strict();
//#endregion
//#region src/app/versions.ts
/**
* Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
* Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
* Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
*/
var Versions = class {
	store;
	pointer;
	family;
	constructor(store, pointer, family) {
		this.store = store;
		this.pointer = pointer;
		this.family = family;
	}
	/** Current revision number, or `0` before the first save. */
	revision() {
		return this.store.get(this.pointer) ?? 0;
	}
	/** Current snapshot, or `undefined` before the first save. */
	current() {
		const revision = this.store.get(this.pointer);
		return revision === void 0 ? void 0 : this.get(revision);
	}
	get(revision) {
		return this.store.get(this.family(revision));
	}
	save(make) {
		return this.store.atomic(() => {
			const version = make(this.revision() + 1);
			this.store.set(this.family(version.revision), version);
			this.store.set(this.pointer, version.revision);
			return version;
		});
	}
	/** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
	keep(version) {
		this.store.set(this.family(version.revision), version);
	}
	list(limit = Infinity) {
		return this.store.keys(this.family).flatMap((name) => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit);
	}
};
//#endregion
//#region src/app/store-read.ts
function storeReads(db) {
	const values = (sql, ...parameters) => db.prepare(sql).all(...parameters).map((row) => JSON.parse(String(row.value)));
	return {
		/** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
		recentTriggers: (offset = 0, limit = 50) => db.prepare("SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit, offset).map((row) => JSON.parse(String(row.value))),
		/** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
		triggerStats: (since) => {
			const result = {};
			for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since)) result[String(row.source)] = {
				received: Number(row.received ?? 0),
				filtered: Number(row.filtered ?? 0),
				lastAt: String(row.last ?? "")
			};
			return result;
		},
		/**
		* Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
		* and how many accept/reopen decisions those same arrivals produced.
		*/
		flow: (since) => {
			const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '\$.filtered') IS NOT NULL)`).get(since);
			const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since);
			return {
				judged: Number(judged?.n ?? 0),
				accepted: Number(accepted?.n ?? 0)
			};
		},
		triggers: (options, offset = 0, limit = 50) => {
			const where = [...options.source ? ["json_extract(t.value, '$.source') = ?"] : [], ...options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : []];
			const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...options.source ? [options.source] : [], limit + 1, offset);
			return {
				items: rows.slice(0, limit).map((row) => JSON.parse(String(row.value))),
				more: rows.length > limit
			};
		},
		/** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
		threadTriggers: (threadKeyValue, limit = 50, before, through = false) => {
			return values(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${before ? `AND (x.at, x.id) ${through ? "<=" : "<"} (?, ?)` : ""}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse();
		},
		threadPage: (threadKeyValue, offset, limit) => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
		/** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
		neighbours: (threadKeyValue, at, id) => {
			const nearest = (side) => values(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === "<" ? "DESC" : "ASC"}, x.id ${side === "<" ? "DESC" : "ASC"} LIMIT 1`, threadKeyValue, at, id)[0];
			const before = nearest("<"), after = nearest(">");
			return {
				...before ? { before } : {},
				...after ? { after } : {}
			};
		},
		/** Oldest trigger on a thread, used to title the thread in listings. */
		firstTrigger: (threadKeyValue, humanOnly = false) => {
			const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? "AND x.human = 1" : ""} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		search: (query, limit = 20) => {
			const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
			return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`, query, pattern, limit).map((row) => JSON.parse(String(row.value)));
		},
		recentDecisions: (offset = 0, limit = 50) => db.prepare("SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?").all(limit, offset).map((row) => JSON.parse(String(row.value))),
		/** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
		decisions: (options, offset, limit) => {
			const where = [...options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => "?").join(",")})`] : [], ...options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : []];
			const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`).all(...options.kinds, ...options.since ? [options.since] : [], limit + 1, offset);
			return {
				items: rows.slice(0, limit).map((row) => JSON.parse(String(row.value))),
				more: rows.length > limit
			};
		},
		/** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
		decisionsOfKinds: (kinds, limit = 30) => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => "?").join(",")}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map((row) => JSON.parse(String(row.value))),
		/** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
		failingReplies: () => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all().map((row) => ({
			...JSON.parse(String(row.value)),
			attempts: Number(row.attempts),
			error: String(row.error)
		})),
		droppedReplies: (limit = 20) => values("SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?", limit),
		droppedSince: (since) => Number(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?").get(since)?.n ?? 0),
		subscribedThreads: (source) => source ? values("SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid", source) : values("SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid")
	};
}
//#endregion
//#region src/app/store.ts
/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
const OLDEST_SCHEMA = 11;
const tooOld = (version) => `Unsupported local Superagent database version ${version}`;
const migrateTo11 = (_store) => {
	throw new Error("Pre-11 databases are not supported by the local preset");
};
/**
* Generated columns and partial indexes defining active working sets so passes scan only active rows.
* Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
*/
const SETS = {
	ticket: {
		open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
		active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`
	},
	thread: {
		active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
		subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)"
	},
	outbox: {
		dropped: "TEXT AS (value ->> '$.dropped.at')",
		pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)`
	}
};
/**
* SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
* The Runtime opens it after locking the state directory and automatically migrates supported older schemas on startup.
* The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
*/
var Store = class {
	report;
	db;
	/**
	* Opens or creates the SQLite database at `path`, migrating schema 10 to schema 11 in a single transaction.
	* @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
	* @throws When the database schema is older than `OLDEST_SCHEMA` (10), newer than `SCHEMA_VERSION` (11), or when migration fails; in every case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
	*/
	constructor(path, report = () => {}) {
		this.report = report;
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		this.read = storeReads(this.db);
		try {
			chmodSync(path, 384);
			this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			const version = this.get(KV.store.schema);
			if (version !== void 0 && version > 11) throw new Error(`Unsupported orchestrator database version ${version}`);
			if (version !== void 0 && version < OLDEST_SCHEMA) throw new Error(tooOld(version));
			const migrating = version !== void 0 && version < 11;
			try {
				this.atomic(() => {
					this.db.exec(`
            CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
              PRIMARY KEY (thread, id));
            CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
              generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
              since TEXT NOT NULL, PRIMARY KEY (kind, key));
            CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
            CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
            CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
            CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
          `);
					this.addColumns();
					if (migrating) migrateTo11(this);
					if (version !== 11) this.set(KV.store.schema, 11);
				});
			} catch (error) {
				if (!migrating) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`The orchestrator database is unchanged at schema ${version}: its migration to schema 11 failed: ${reason}`, { cause: error });
			}
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	/** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
	addColumns() {
		const columns = (table) => new Set(this.db.prepare("SELECT name FROM pragma_table_xinfo(?)").all(table).map((row) => String(row.name)));
		for (const [table, definitions] of Object.entries(SETS)) {
			const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? "");
			const generated = this.db.prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)").all(table).map((row) => String(row.name));
			for (const name of generated) {
				if (definitions[name] && sql.includes(`${name} ${definitions[name]}`)) continue;
				this.db.exec(`DROP INDEX IF EXISTS ${table}_${name}; ALTER TABLE ${table} DROP COLUMN ${name}`);
			}
			const existing = columns(table);
			for (const [name, definition] of Object.entries(definitions)) {
				if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
				this.db.exec(`CREATE INDEX IF NOT EXISTS ${table}_${name} ON ${table}(${name}) WHERE ${name} IS NOT NULL`);
			}
		}
		if (!columns("effect").has("generation")) this.db.exec("ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0");
	}
	/** Closes the underlying SQLite database connection. */
	close() {
		this.db.close();
	}
	/** Parses JSON `value` columns returned by `sql`. */
	values(sql, ...parameters) {
		return this.db.prepare(sql).all(...parameters).map((row) => JSON.parse(String(row.value)));
	}
	/** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
	indexThreads(trigger) {
		this.db.prepare("DELETE FROM trigger_thread WHERE id=?").run(trigger.id);
		const insert = this.db.prepare("INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)");
		for (const ref of trigger.threads) insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0);
	}
	depth = 0;
	/** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
	committed = [];
	/**
	* Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
	* Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
	*/
	atomic(operation) {
		const level = this.depth++;
		const name = `orchestrator_atomic_${level}`;
		this.committed[level] = [];
		this.db.exec(`SAVEPOINT ${name}`);
		let value;
		try {
			value = operation();
			this.db.exec(`RELEASE ${name}`);
		} catch (error) {
			this.db.exec(`ROLLBACK TO ${name}`);
			this.db.exec(`RELEASE ${name}`);
			throw error;
		} finally {
			this.depth--;
		}
		const actions = this.committed.splice(level)[0];
		if (level) this.committed[level - 1].push(...actions);
		else for (const action of actions) try {
			action();
		} catch (error) {
			this.report(error);
		}
		return value;
	}
	/**
	* Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
	* callbacks queued inside a transaction that rolls back are discarded and never run.
	* Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
	*/
	afterCommit(action) {
		if (this.depth) this.committed[this.depth - 1].push(action);
		else action();
	}
	/** Reads a typed KV record by its key in `KV`. */
	get(name) {
		const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(name);
		return row === void 0 ? void 0 : JSON.parse(String(row.value));
	}
	/** Writes a typed KV record under `name`. */
	set(name, value) {
		this.db.prepare("INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name, JSON.stringify(value));
	}
	/** Deletes the KV record at `name`. */
	delete(name) {
		this.db.prepare("DELETE FROM kv WHERE key=?").run(name);
	}
	keys(family) {
		const pattern = `${(typeof family === "string" ? family : family.prefix).replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
		return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map((row) => String(row.key));
	}
	/** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
	settingsVersions = new Versions(this, KV.settings.revision, KV.settings.version);
	/** Current validated settings. */
	settings() {
		return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {});
	}
	/** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
	blockRevision(block) {
		return this.get(KV.settings.block(block)) ?? 0;
	}
	/** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
	saveSettings(value, record = {
		source: "internal",
		policyVersion: "",
		policyChanged: false,
		notified: []
	}) {
		const settings = SettingsSchema.parse(value);
		return this.atomic(() => {
			this.settingsVersions.save((revision) => ({
				...record,
				revision,
				savedAt: (/* @__PURE__ */ new Date()).toISOString(),
				settings
			}));
			if (record.block) this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1);
			return settings;
		});
	}
	/** Saved settings revisions, newest first; revisions predating settings history are absent. */
	settingsHistory(limit = 20) {
		return this.settingsVersions.list(limit);
	}
	triggers = {
		get: (id) => {
			const row = this.db.prepare("SELECT value FROM trigger WHERE id=?").get(id);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		save: (trigger) => this.atomic(() => {
			this.db.prepare("INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at").run(trigger.id, JSON.stringify(trigger), trigger.at);
			this.indexThreads(trigger);
		}),
		disposition: (id) => {
			const row = this.db.prepare("SELECT value FROM disposition WHERE id=?").get(id);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		saveDisposition: (id, value) => {
			this.db.prepare("INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value));
		}
	};
	threads = {
		get: (keyValue) => {
			const row = this.db.prepare("SELECT value FROM thread WHERE key=?").get(keyValue);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		save: (thread) => {
			this.db.prepare("INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(thread.key, JSON.stringify(thread));
		},
		list: () => this.db.prepare("SELECT value FROM thread ORDER BY rowid").all().map((row) => JSON.parse(String(row.value))),
		active: () => this.values("SELECT value FROM thread WHERE active = 1 ORDER BY rowid"),
		/** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
		describe: (keyValue, patch) => {
			const thread = this.threads.get(keyValue);
			if (!thread) return;
			const facts = { ...thread.meta.facts };
			for (const [id, fact] of Object.entries(patch.facts ?? {})) if (fact) facts[id] = fact;
			else delete facts[id];
			const meta = {
				...thread.meta,
				...patch.label === void 0 ? {} : { label: patch.label },
				...patch.url === void 0 ? {} : { url: patch.url },
				facts
			};
			if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({
				...thread,
				meta
			});
		},
		/** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
		patchMeta: (keyValue, patch) => this.atomic(() => {
			const thread = this.threads.get(keyValue);
			if (!thread) return;
			const meta = { ...thread.meta };
			for (const [name, value] of Object.entries(patch)) if (value === void 0) delete meta[name];
			else meta[name] = value;
			if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({
				...thread,
				meta
			});
		})
	};
	tickets = {
		get: (id) => {
			const row = this.db.prepare("SELECT value FROM ticket WHERE id=?").get(id);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		save: (ticket) => {
			this.db.prepare("INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(ticket.id, JSON.stringify(ticket));
		},
		/** Newest first. */
		list: () => this.values("SELECT value FROM ticket ORDER BY rowid DESC"),
		/** Newest first. */
		open: () => this.values("SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC"),
		/** Newest first. */
		active: () => this.values("SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC")
	};
	decisions = {
		get: (id) => {
			const row = this.db.prepare("SELECT value FROM decision WHERE id=?").get(id);
			return row ? JSON.parse(String(row.value)) : void 0;
		},
		save: (decision) => {
			this.db.prepare("INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread").run(decision.id, decision.threadKey, JSON.stringify(decision));
		},
		byThread: (threadKeyValue) => this.db.prepare("SELECT value FROM decision WHERE thread=? ORDER BY rowid").all(threadKeyValue).map((row) => JSON.parse(String(row.value)))
	};
	/** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
	read;
	/** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
	replyStatus(id) {
		return this.receipts.get(id)?.status;
	}
	/** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
	receipts = {
		get: (id) => this.values("SELECT value FROM outbox WHERE id = ?", id)[0],
		/** Pending message receipts, oldest first. */
		waiting: () => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
		/** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
		behind: (id, failures) => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
		/**
		* Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
		* @returns Whether the message ID was newly recorded.
		*/
		add: (message) => {
			const receipt = {
				...message,
				status: "pending"
			};
			return Number(this.db.prepare("INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)").run(message.id, JSON.stringify(receipt)).changes) > 0;
		},
		/**
		* Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
		* was withdrawn while being sent so its ID cannot be queued again.
		*/
		settle: (message, outcome) => {
			const settled = outcome === "sent" ? { status: "sent" } : {
				status: "dropped",
				dropped: {
					at: (/* @__PURE__ */ new Date()).toISOString(),
					reason: outcome
				}
			};
			const { id, channel, text, kind, ticketId } = message;
			const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'").run(JSON.stringify(settled), id);
			if (!Number(updated.changes)) this.db.prepare("INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)").run(id, JSON.stringify({
				id,
				channel,
				text,
				kind,
				...ticketId ? { ticketId } : {},
				...settled
			}));
		},
		/**
		* Withdraws a pending message that has not yet been sent.
		* @returns Whether a pending message with `id` was waiting and removed.
		*/
		withdraw: (id) => Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0
	};
};
//#endregion
//#region src/infra/health.ts
/**
* Central registry of component health entries, enforcing single-writer ownership per entry name.
* Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
*/
var HealthBoard = class {
	entries = {};
	claimed = /* @__PURE__ */ new Set();
	claim(name, initial) {
		if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`);
		this.claimed.add(name);
		if (initial) this.entries[name] = initial;
		let held = true;
		return {
			get: () => this.entries[name],
			set: (health) => {
				if (held) this.entries[name] = health;
			},
			release: () => {
				if (!held) return;
				held = false;
				this.claimed.delete(name);
				delete this.entries[name];
			}
		};
	}
	get all() {
		return this.entries;
	}
};
//#endregion
//#region src/executor/background.ts
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 1e4;
const registry = (ctx) => ctx.get("jobs");
const running = (status) => status === "running" || status === "stopping";
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs, sessionId, except) => jobs.list(sessionId).filter((job) => job.owner === sessionId && running(job.status) && !except?.has(job.id));
/** A job by its id and the first line of its label. */
const named = (job) => {
	const line = job.label?.split("\n")[0]?.trim();
	return line ? `${job.id} (${line})` : job.id;
};
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
const runningJobs = (ctx, sessionId, except) => {
	const jobs = registry(ctx);
	return jobs ? owned(jobs, sessionId, except).map((job) => ({
		id: job.id,
		name: named(job)
	})) : [];
};
/**
* Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
* One failure stops none other.
*/
async function killJobs(ctx, sessionId, reason, except) {
	const jobs = registry(ctx);
	const live = jobs ? owned(jobs, sessionId, except) : [];
	const failures = [];
	const collected = live.map((job) => jobs.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => void 0));
	for (const job of live) try {
		jobs.kill(job.id, sessionId, reason);
	} catch (error) {
		failures.push(error);
	}
	await Promise.all(collected);
	if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`);
}
//#endregion
//#region node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/polyfills.js
var require_polyfills = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var constants = __require("constants");
	var origCwd = process.cwd;
	var cwd = null;
	var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
	process.cwd = function() {
		if (!cwd) cwd = origCwd.call(process);
		return cwd;
	};
	try {
		process.cwd();
	} catch (er) {}
	if (typeof process.chdir === "function") {
		var chdir = process.chdir;
		process.chdir = function(d) {
			cwd = null;
			chdir.call(process, d);
		};
		if (Object.setPrototypeOf) Object.setPrototypeOf(process.chdir, chdir);
	}
	module.exports = patch;
	function patch(fs) {
		if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) patchLchmod(fs);
		if (!fs.lutimes) patchLutimes(fs);
		fs.chown = chownFix(fs.chown);
		fs.fchown = chownFix(fs.fchown);
		fs.lchown = chownFix(fs.lchown);
		fs.chmod = chmodFix(fs.chmod);
		fs.fchmod = chmodFix(fs.fchmod);
		fs.lchmod = chmodFix(fs.lchmod);
		fs.chownSync = chownFixSync(fs.chownSync);
		fs.fchownSync = chownFixSync(fs.fchownSync);
		fs.lchownSync = chownFixSync(fs.lchownSync);
		fs.chmodSync = chmodFixSync(fs.chmodSync);
		fs.fchmodSync = chmodFixSync(fs.fchmodSync);
		fs.lchmodSync = chmodFixSync(fs.lchmodSync);
		fs.stat = statFix(fs.stat);
		fs.fstat = statFix(fs.fstat);
		fs.lstat = statFix(fs.lstat);
		fs.statSync = statFixSync(fs.statSync);
		fs.fstatSync = statFixSync(fs.fstatSync);
		fs.lstatSync = statFixSync(fs.lstatSync);
		if (fs.chmod && !fs.lchmod) {
			fs.lchmod = function(path, mode, cb) {
				if (cb) process.nextTick(cb);
			};
			fs.lchmodSync = function() {};
		}
		if (fs.chown && !fs.lchown) {
			fs.lchown = function(path, uid, gid, cb) {
				if (cb) process.nextTick(cb);
			};
			fs.lchownSync = function() {};
		}
		if (platform === "win32") fs.rename = typeof fs.rename !== "function" ? fs.rename : (function(fs$rename) {
			function rename(from, to, cb) {
				var start = Date.now();
				var backoff = 0;
				fs$rename(from, to, function CB(er) {
					if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 6e4) {
						setTimeout(function() {
							fs.stat(to, function(stater, st) {
								if (stater && stater.code === "ENOENT") fs$rename(from, to, CB);
								else cb(er);
							});
						}, backoff);
						if (backoff < 100) backoff += 10;
						return;
					}
					if (cb) cb(er);
				});
			}
			if (Object.setPrototypeOf) Object.setPrototypeOf(rename, fs$rename);
			return rename;
		})(fs.rename);
		fs.read = typeof fs.read !== "function" ? fs.read : (function(fs$read) {
			function read(fd, buffer, offset, length, position, callback_) {
				var callback;
				if (callback_ && typeof callback_ === "function") {
					var eagCounter = 0;
					callback = function(er, _, __) {
						if (er && er.code === "EAGAIN" && eagCounter < 10) {
							eagCounter++;
							return fs$read.call(fs, fd, buffer, offset, length, position, callback);
						}
						callback_.apply(this, arguments);
					};
				}
				return fs$read.call(fs, fd, buffer, offset, length, position, callback);
			}
			if (Object.setPrototypeOf) Object.setPrototypeOf(read, fs$read);
			return read;
		})(fs.read);
		fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : (function(fs$readSync) {
			return function(fd, buffer, offset, length, position) {
				var eagCounter = 0;
				while (true) try {
					return fs$readSync.call(fs, fd, buffer, offset, length, position);
				} catch (er) {
					if (er.code === "EAGAIN" && eagCounter < 10) {
						eagCounter++;
						continue;
					}
					throw er;
				}
			};
		})(fs.readSync);
		function patchLchmod(fs) {
			fs.lchmod = function(path, mode, callback) {
				fs.open(path, constants.O_WRONLY | constants.O_SYMLINK, mode, function(err, fd) {
					if (err) {
						if (callback) callback(err);
						return;
					}
					fs.fchmod(fd, mode, function(err) {
						fs.close(fd, function(err2) {
							if (callback) callback(err || err2);
						});
					});
				});
			};
			fs.lchmodSync = function(path, mode) {
				var fd = fs.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);
				var threw = true;
				var ret;
				try {
					ret = fs.fchmodSync(fd, mode);
					threw = false;
				} finally {
					if (threw) try {
						fs.closeSync(fd);
					} catch (er) {}
					else fs.closeSync(fd);
				}
				return ret;
			};
		}
		function patchLutimes(fs) {
			if (constants.hasOwnProperty("O_SYMLINK") && fs.futimes) {
				fs.lutimes = function(path, at, mt, cb) {
					fs.open(path, constants.O_SYMLINK, function(er, fd) {
						if (er) {
							if (cb) cb(er);
							return;
						}
						fs.futimes(fd, at, mt, function(er) {
							fs.close(fd, function(er2) {
								if (cb) cb(er || er2);
							});
						});
					});
				};
				fs.lutimesSync = function(path, at, mt) {
					var fd = fs.openSync(path, constants.O_SYMLINK);
					var ret;
					var threw = true;
					try {
						ret = fs.futimesSync(fd, at, mt);
						threw = false;
					} finally {
						if (threw) try {
							fs.closeSync(fd);
						} catch (er) {}
						else fs.closeSync(fd);
					}
					return ret;
				};
			} else if (fs.futimes) {
				fs.lutimes = function(_a, _b, _c, cb) {
					if (cb) process.nextTick(cb);
				};
				fs.lutimesSync = function() {};
			}
		}
		function chmodFix(orig) {
			if (!orig) return orig;
			return function(target, mode, cb) {
				return orig.call(fs, target, mode, function(er) {
					if (chownErOk(er)) er = null;
					if (cb) cb.apply(this, arguments);
				});
			};
		}
		function chmodFixSync(orig) {
			if (!orig) return orig;
			return function(target, mode) {
				try {
					return orig.call(fs, target, mode);
				} catch (er) {
					if (!chownErOk(er)) throw er;
				}
			};
		}
		function chownFix(orig) {
			if (!orig) return orig;
			return function(target, uid, gid, cb) {
				return orig.call(fs, target, uid, gid, function(er) {
					if (chownErOk(er)) er = null;
					if (cb) cb.apply(this, arguments);
				});
			};
		}
		function chownFixSync(orig) {
			if (!orig) return orig;
			return function(target, uid, gid) {
				try {
					return orig.call(fs, target, uid, gid);
				} catch (er) {
					if (!chownErOk(er)) throw er;
				}
			};
		}
		function statFix(orig) {
			if (!orig) return orig;
			return function(target, options, cb) {
				if (typeof options === "function") {
					cb = options;
					options = null;
				}
				function callback(er, stats) {
					if (stats) {
						if (stats.uid < 0) stats.uid += 4294967296;
						if (stats.gid < 0) stats.gid += 4294967296;
					}
					if (cb) cb.apply(this, arguments);
				}
				return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
			};
		}
		function statFixSync(orig) {
			if (!orig) return orig;
			return function(target, options) {
				var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
				if (stats) {
					if (stats.uid < 0) stats.uid += 4294967296;
					if (stats.gid < 0) stats.gid += 4294967296;
				}
				return stats;
			};
		}
		function chownErOk(er) {
			if (!er) return true;
			if (er.code === "ENOSYS") return true;
			if (!process.getuid || process.getuid() !== 0) {
				if (er.code === "EINVAL" || er.code === "EPERM") return true;
			}
			return false;
		}
	}
}));
//#endregion
//#region node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Stream = __require("stream").Stream;
	module.exports = legacy;
	function legacy(fs) {
		return {
			ReadStream,
			WriteStream
		};
		function ReadStream(path, options) {
			if (!(this instanceof ReadStream)) return new ReadStream(path, options);
			Stream.call(this);
			var self = this;
			this.path = path;
			this.fd = null;
			this.readable = true;
			this.paused = false;
			this.flags = "r";
			this.mode = 438;
			this.bufferSize = 65536;
			options = options || {};
			var keys = Object.keys(options);
			for (var index = 0, length = keys.length; index < length; index++) {
				var key = keys[index];
				this[key] = options[key];
			}
			if (this.encoding) this.setEncoding(this.encoding);
			if (this.start !== void 0) {
				if ("number" !== typeof this.start) throw TypeError("start must be a Number");
				if (this.end === void 0) this.end = Infinity;
				else if ("number" !== typeof this.end) throw TypeError("end must be a Number");
				if (this.start > this.end) throw new Error("start must be <= end");
				this.pos = this.start;
			}
			if (this.fd !== null) {
				process.nextTick(function() {
					self._read();
				});
				return;
			}
			fs.open(this.path, this.flags, this.mode, function(err, fd) {
				if (err) {
					self.emit("error", err);
					self.readable = false;
					return;
				}
				self.fd = fd;
				self.emit("open", fd);
				self._read();
			});
		}
		function WriteStream(path, options) {
			if (!(this instanceof WriteStream)) return new WriteStream(path, options);
			Stream.call(this);
			this.path = path;
			this.fd = null;
			this.writable = true;
			this.flags = "w";
			this.encoding = "binary";
			this.mode = 438;
			this.bytesWritten = 0;
			options = options || {};
			var keys = Object.keys(options);
			for (var index = 0, length = keys.length; index < length; index++) {
				var key = keys[index];
				this[key] = options[key];
			}
			if (this.start !== void 0) {
				if ("number" !== typeof this.start) throw TypeError("start must be a Number");
				if (this.start < 0) throw new Error("start must be >= zero");
				this.pos = this.start;
			}
			this.busy = false;
			this._queue = [];
			if (this.fd === null) {
				this._open = fs.open;
				this._queue.push([
					this._open,
					this.path,
					this.flags,
					this.mode,
					void 0
				]);
				this.flush();
			}
		}
	}
}));
//#endregion
//#region node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/clone.js
var require_clone = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = clone;
	var getPrototypeOf = Object.getPrototypeOf || function(obj) {
		return obj.__proto__;
	};
	function clone(obj) {
		if (obj === null || typeof obj !== "object") return obj;
		if (obj instanceof Object) var copy = { __proto__: getPrototypeOf(obj) };
		else var copy = Object.create(null);
		Object.getOwnPropertyNames(obj).forEach(function(key) {
			Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
		});
		return copy;
	}
}));
//#endregion
//#region node_modules/.pnpm/graceful-fs@4.2.11/node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var fs = __require("fs");
	var polyfills = require_polyfills();
	var legacy = require_legacy_streams();
	var clone = require_clone();
	var util = __require("util");
	/* istanbul ignore next - node 0.x polyfill */
	var gracefulQueue;
	var previousSymbol;
	/* istanbul ignore else - node 0.x polyfill */
	if (typeof Symbol === "function" && typeof Symbol.for === "function") {
		gracefulQueue = Symbol.for("graceful-fs.queue");
		previousSymbol = Symbol.for("graceful-fs.previous");
	} else {
		gracefulQueue = "___graceful-fs.queue";
		previousSymbol = "___graceful-fs.previous";
	}
	function noop() {}
	function publishQueue(context, queue) {
		Object.defineProperty(context, gracefulQueue, { get: function() {
			return queue;
		} });
	}
	var debug = noop;
	if (util.debuglog) debug = util.debuglog("gfs4");
	else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) debug = function() {
		var m = util.format.apply(util, arguments);
		m = "GFS4: " + m.split(/\n/).join("\nGFS4: ");
		console.error(m);
	};
	if (!fs[gracefulQueue]) {
		publishQueue(fs, global[gracefulQueue] || []);
		fs.close = (function(fs$close) {
			function close(fd, cb) {
				return fs$close.call(fs, fd, function(err) {
					if (!err) resetQueue();
					if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
			Object.defineProperty(close, previousSymbol, { value: fs$close });
			return close;
		})(fs.close);
		fs.closeSync = (function(fs$closeSync) {
			function closeSync(fd) {
				fs$closeSync.apply(fs, arguments);
				resetQueue();
			}
			Object.defineProperty(closeSync, previousSymbol, { value: fs$closeSync });
			return closeSync;
		})(fs.closeSync);
		if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) process.on("exit", function() {
			debug(fs[gracefulQueue]);
			__require("assert").equal(fs[gracefulQueue].length, 0);
		});
	}
	if (!global[gracefulQueue]) publishQueue(global, fs[gracefulQueue]);
	module.exports = patch(clone(fs));
	if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
		module.exports = patch(fs);
		fs.__patched = true;
	}
	function patch(fs) {
		polyfills(fs);
		fs.gracefulify = patch;
		fs.createReadStream = createReadStream;
		fs.createWriteStream = createWriteStream;
		var fs$readFile = fs.readFile;
		fs.readFile = readFile;
		function readFile(path, options, cb) {
			if (typeof options === "function") cb = options, options = null;
			return go$readFile(path, options, cb);
			function go$readFile(path, options, cb, startTime) {
				return fs$readFile(path, options, function(err) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$readFile,
						[
							path,
							options,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
		}
		var fs$writeFile = fs.writeFile;
		fs.writeFile = writeFile;
		function writeFile(path, data, options, cb) {
			if (typeof options === "function") cb = options, options = null;
			return go$writeFile(path, data, options, cb);
			function go$writeFile(path, data, options, cb, startTime) {
				return fs$writeFile(path, data, options, function(err) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$writeFile,
						[
							path,
							data,
							options,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
		}
		var fs$appendFile = fs.appendFile;
		if (fs$appendFile) fs.appendFile = appendFile;
		function appendFile(path, data, options, cb) {
			if (typeof options === "function") cb = options, options = null;
			return go$appendFile(path, data, options, cb);
			function go$appendFile(path, data, options, cb, startTime) {
				return fs$appendFile(path, data, options, function(err) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$appendFile,
						[
							path,
							data,
							options,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
		}
		var fs$copyFile = fs.copyFile;
		if (fs$copyFile) fs.copyFile = copyFile;
		function copyFile(src, dest, flags, cb) {
			if (typeof flags === "function") {
				cb = flags;
				flags = 0;
			}
			return go$copyFile(src, dest, flags, cb);
			function go$copyFile(src, dest, flags, cb, startTime) {
				return fs$copyFile(src, dest, flags, function(err) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$copyFile,
						[
							src,
							dest,
							flags,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
		}
		var fs$readdir = fs.readdir;
		fs.readdir = readdir;
		var noReaddirOptionVersions = /^v[0-5]\./;
		function readdir(path, options, cb) {
			if (typeof options === "function") cb = options, options = null;
			var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir(path, options, cb, startTime) {
				return fs$readdir(path, fs$readdirCallback(path, options, cb, startTime));
			} : function go$readdir(path, options, cb, startTime) {
				return fs$readdir(path, options, fs$readdirCallback(path, options, cb, startTime));
			};
			return go$readdir(path, options, cb);
			function fs$readdirCallback(path, options, cb, startTime) {
				return function(err, files) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$readdir,
						[
							path,
							options,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else {
						if (files && files.sort) files.sort();
						if (typeof cb === "function") cb.call(this, err, files);
					}
				};
			}
		}
		if (process.version.substr(0, 4) === "v0.8") {
			var legStreams = legacy(fs);
			ReadStream = legStreams.ReadStream;
			WriteStream = legStreams.WriteStream;
		}
		var fs$ReadStream = fs.ReadStream;
		if (fs$ReadStream) {
			ReadStream.prototype = Object.create(fs$ReadStream.prototype);
			ReadStream.prototype.open = ReadStream$open;
		}
		var fs$WriteStream = fs.WriteStream;
		if (fs$WriteStream) {
			WriteStream.prototype = Object.create(fs$WriteStream.prototype);
			WriteStream.prototype.open = WriteStream$open;
		}
		Object.defineProperty(fs, "ReadStream", {
			get: function() {
				return ReadStream;
			},
			set: function(val) {
				ReadStream = val;
			},
			enumerable: true,
			configurable: true
		});
		Object.defineProperty(fs, "WriteStream", {
			get: function() {
				return WriteStream;
			},
			set: function(val) {
				WriteStream = val;
			},
			enumerable: true,
			configurable: true
		});
		var FileReadStream = ReadStream;
		Object.defineProperty(fs, "FileReadStream", {
			get: function() {
				return FileReadStream;
			},
			set: function(val) {
				FileReadStream = val;
			},
			enumerable: true,
			configurable: true
		});
		var FileWriteStream = WriteStream;
		Object.defineProperty(fs, "FileWriteStream", {
			get: function() {
				return FileWriteStream;
			},
			set: function(val) {
				FileWriteStream = val;
			},
			enumerable: true,
			configurable: true
		});
		function ReadStream(path, options) {
			if (this instanceof ReadStream) return fs$ReadStream.apply(this, arguments), this;
			else return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
		}
		function ReadStream$open() {
			var that = this;
			open(that.path, that.flags, that.mode, function(err, fd) {
				if (err) {
					if (that.autoClose) that.destroy();
					that.emit("error", err);
				} else {
					that.fd = fd;
					that.emit("open", fd);
					that.read();
				}
			});
		}
		function WriteStream(path, options) {
			if (this instanceof WriteStream) return fs$WriteStream.apply(this, arguments), this;
			else return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
		}
		function WriteStream$open() {
			var that = this;
			open(that.path, that.flags, that.mode, function(err, fd) {
				if (err) {
					that.destroy();
					that.emit("error", err);
				} else {
					that.fd = fd;
					that.emit("open", fd);
				}
			});
		}
		function createReadStream(path, options) {
			return new fs.ReadStream(path, options);
		}
		function createWriteStream(path, options) {
			return new fs.WriteStream(path, options);
		}
		var fs$open = fs.open;
		fs.open = open;
		function open(path, flags, mode, cb) {
			if (typeof mode === "function") cb = mode, mode = null;
			return go$open(path, flags, mode, cb);
			function go$open(path, flags, mode, cb, startTime) {
				return fs$open(path, flags, mode, function(err, fd) {
					if (err && (err.code === "EMFILE" || err.code === "ENFILE")) enqueue([
						go$open,
						[
							path,
							flags,
							mode,
							cb
						],
						err,
						startTime || Date.now(),
						Date.now()
					]);
					else if (typeof cb === "function") cb.apply(this, arguments);
				});
			}
		}
		return fs;
	}
	function enqueue(elem) {
		debug("ENQUEUE", elem[0].name, elem[1]);
		fs[gracefulQueue].push(elem);
		retry();
	}
	var retryTimer;
	function resetQueue() {
		var now = Date.now();
		for (var i = 0; i < fs[gracefulQueue].length; ++i) if (fs[gracefulQueue][i].length > 2) {
			fs[gracefulQueue][i][3] = now;
			fs[gracefulQueue][i][4] = now;
		}
		retry();
	}
	function retry() {
		clearTimeout(retryTimer);
		retryTimer = void 0;
		if (fs[gracefulQueue].length === 0) return;
		var elem = fs[gracefulQueue].shift();
		var fn = elem[0];
		var args = elem[1];
		var err = elem[2];
		var startTime = elem[3];
		var lastTime = elem[4];
		if (startTime === void 0) {
			debug("RETRY", fn.name, args);
			fn.apply(null, args);
		} else if (Date.now() - startTime >= 6e4) {
			debug("TIMEOUT", fn.name, args);
			var cb = args.pop();
			if (typeof cb === "function") cb.call(null, err);
		} else {
			var sinceAttempt = Date.now() - lastTime;
			var sinceStart = Math.max(lastTime - startTime, 1);
			if (sinceAttempt >= Math.min(sinceStart * 1.2, 100)) {
				debug("RETRY", fn.name, args);
				fn.apply(null, args.concat([startTime]));
			} else fs[gracefulQueue].push(elem);
		}
		if (retryTimer === void 0) retryTimer = setTimeout(retry, 0);
	}
}));
//#endregion
//#region node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry_operation.js
var require_retry_operation = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function RetryOperation(timeouts, options) {
		if (typeof options === "boolean") options = { forever: options };
		this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
		this._timeouts = timeouts;
		this._options = options || {};
		this._maxRetryTime = options && options.maxRetryTime || Infinity;
		this._fn = null;
		this._errors = [];
		this._attempts = 1;
		this._operationTimeout = null;
		this._operationTimeoutCb = null;
		this._timeout = null;
		this._operationStart = null;
		if (this._options.forever) this._cachedTimeouts = this._timeouts.slice(0);
	}
	module.exports = RetryOperation;
	RetryOperation.prototype.reset = function() {
		this._attempts = 1;
		this._timeouts = this._originalTimeouts;
	};
	RetryOperation.prototype.stop = function() {
		if (this._timeout) clearTimeout(this._timeout);
		this._timeouts = [];
		this._cachedTimeouts = null;
	};
	RetryOperation.prototype.retry = function(err) {
		if (this._timeout) clearTimeout(this._timeout);
		if (!err) return false;
		var currentTime = (/* @__PURE__ */ new Date()).getTime();
		if (err && currentTime - this._operationStart >= this._maxRetryTime) {
			this._errors.unshift(/* @__PURE__ */ new Error("RetryOperation timeout occurred"));
			return false;
		}
		this._errors.push(err);
		var timeout = this._timeouts.shift();
		if (timeout === void 0) {
			if (this._cachedTimeouts) {
				this._errors.splice(this._errors.length - 1, this._errors.length);
				this._timeouts = this._cachedTimeouts.slice(0);
				timeout = this._timeouts.shift();
			} else return false;
		}
		var self = this;
		var timer = setTimeout(function() {
			self._attempts++;
			if (self._operationTimeoutCb) {
				self._timeout = setTimeout(function() {
					self._operationTimeoutCb(self._attempts);
				}, self._operationTimeout);
				if (self._options.unref) self._timeout.unref();
			}
			self._fn(self._attempts);
		}, timeout);
		if (this._options.unref) timer.unref();
		return true;
	};
	RetryOperation.prototype.attempt = function(fn, timeoutOps) {
		this._fn = fn;
		if (timeoutOps) {
			if (timeoutOps.timeout) this._operationTimeout = timeoutOps.timeout;
			if (timeoutOps.cb) this._operationTimeoutCb = timeoutOps.cb;
		}
		var self = this;
		if (this._operationTimeoutCb) this._timeout = setTimeout(function() {
			self._operationTimeoutCb();
		}, self._operationTimeout);
		this._operationStart = (/* @__PURE__ */ new Date()).getTime();
		this._fn(this._attempts);
	};
	RetryOperation.prototype.try = function(fn) {
		console.log("Using RetryOperation.try() is deprecated");
		this.attempt(fn);
	};
	RetryOperation.prototype.start = function(fn) {
		console.log("Using RetryOperation.start() is deprecated");
		this.attempt(fn);
	};
	RetryOperation.prototype.start = RetryOperation.prototype.try;
	RetryOperation.prototype.errors = function() {
		return this._errors;
	};
	RetryOperation.prototype.attempts = function() {
		return this._attempts;
	};
	RetryOperation.prototype.mainError = function() {
		if (this._errors.length === 0) return null;
		var counts = {};
		var mainError = null;
		var mainErrorCount = 0;
		for (var i = 0; i < this._errors.length; i++) {
			var error = this._errors[i];
			var message = error.message;
			var count = (counts[message] || 0) + 1;
			counts[message] = count;
			if (count >= mainErrorCount) {
				mainError = error;
				mainErrorCount = count;
			}
		}
		return mainError;
	};
}));
//#endregion
//#region node_modules/.pnpm/retry@0.12.0/node_modules/retry/lib/retry.js
var require_retry$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var RetryOperation = require_retry_operation();
	exports.operation = function(options) {
		return new RetryOperation(exports.timeouts(options), {
			forever: options && options.forever,
			unref: options && options.unref,
			maxRetryTime: options && options.maxRetryTime
		});
	};
	exports.timeouts = function(options) {
		if (options instanceof Array) return [].concat(options);
		var opts = {
			retries: 10,
			factor: 2,
			minTimeout: 1e3,
			maxTimeout: Infinity,
			randomize: false
		};
		for (var key in options) opts[key] = options[key];
		if (opts.minTimeout > opts.maxTimeout) throw new Error("minTimeout is greater than maxTimeout");
		var timeouts = [];
		for (var i = 0; i < opts.retries; i++) timeouts.push(this.createTimeout(i, opts));
		if (options && options.forever && !timeouts.length) timeouts.push(this.createTimeout(i, opts));
		timeouts.sort(function(a, b) {
			return a - b;
		});
		return timeouts;
	};
	exports.createTimeout = function(attempt, opts) {
		var random = opts.randomize ? Math.random() + 1 : 1;
		var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
		timeout = Math.min(timeout, opts.maxTimeout);
		return timeout;
	};
	exports.wrap = function(obj, options, methods) {
		if (options instanceof Array) {
			methods = options;
			options = null;
		}
		if (!methods) {
			methods = [];
			for (var key in obj) if (typeof obj[key] === "function") methods.push(key);
		}
		for (var i = 0; i < methods.length; i++) {
			var method = methods[i];
			var original = obj[method];
			obj[method] = function retryWrapper(original) {
				var op = exports.operation(options);
				var args = Array.prototype.slice.call(arguments, 1);
				var callback = args.pop();
				args.push(function(err) {
					if (op.retry(err)) return;
					if (err) arguments[0] = op.mainError();
					callback.apply(this, arguments);
				});
				op.attempt(function() {
					original.apply(obj, args);
				});
			}.bind(obj, original);
			obj[method].options = options;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/retry@0.12.0/node_modules/retry/index.js
var require_retry = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_retry$1();
}));
//#endregion
//#region node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/signals.js
var require_signals = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = [
		"SIGABRT",
		"SIGALRM",
		"SIGHUP",
		"SIGINT",
		"SIGTERM"
	];
	if (process.platform !== "win32") module.exports.push("SIGVTALRM", "SIGXCPU", "SIGXFSZ", "SIGUSR2", "SIGTRAP", "SIGSYS", "SIGQUIT", "SIGIOT");
	if (process.platform === "linux") module.exports.push("SIGIO", "SIGPOLL", "SIGPWR", "SIGSTKFLT", "SIGUNUSED");
}));
//#endregion
//#region node_modules/.pnpm/signal-exit@3.0.7/node_modules/signal-exit/index.js
var require_signal_exit = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var process = global.process;
	const processOk = function(process) {
		return process && typeof process === "object" && typeof process.removeListener === "function" && typeof process.emit === "function" && typeof process.reallyExit === "function" && typeof process.listeners === "function" && typeof process.kill === "function" && typeof process.pid === "number" && typeof process.on === "function";
	};
	/* istanbul ignore if */
	if (!processOk(process)) module.exports = function() {
		return function() {};
	};
	else {
		var assert = __require("assert");
		var signals = require_signals();
		var isWin = /^win/i.test(process.platform);
		var EE = __require("events");
		/* istanbul ignore if */
		if (typeof EE !== "function") EE = EE.EventEmitter;
		var emitter;
		if (process.__signal_exit_emitter__) emitter = process.__signal_exit_emitter__;
		else {
			emitter = process.__signal_exit_emitter__ = new EE();
			emitter.count = 0;
			emitter.emitted = {};
		}
		if (!emitter.infinite) {
			emitter.setMaxListeners(Infinity);
			emitter.infinite = true;
		}
		module.exports = function(cb, opts) {
			/* istanbul ignore if */
			if (!processOk(global.process)) return function() {};
			assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
			if (loaded === false) load();
			var ev = "exit";
			if (opts && opts.alwaysLast) ev = "afterexit";
			var remove = function() {
				emitter.removeListener(ev, cb);
				if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) unload();
			};
			emitter.on(ev, cb);
			return remove;
		};
		var unload = function unload() {
			if (!loaded || !processOk(global.process)) return;
			loaded = false;
			signals.forEach(function(sig) {
				try {
					process.removeListener(sig, sigListeners[sig]);
				} catch (er) {}
			});
			process.emit = originalProcessEmit;
			process.reallyExit = originalProcessReallyExit;
			emitter.count -= 1;
		};
		module.exports.unload = unload;
		var emit = function emit(event, code, signal) {
			/* istanbul ignore if */
			if (emitter.emitted[event]) return;
			emitter.emitted[event] = true;
			emitter.emit(event, code, signal);
		};
		var sigListeners = {};
		signals.forEach(function(sig) {
			sigListeners[sig] = function listener() {
				/* istanbul ignore if */
				if (!processOk(global.process)) return;
				if (process.listeners(sig).length === emitter.count) {
					unload();
					emit("exit", null, sig);
					/* istanbul ignore next */
					emit("afterexit", null, sig);
					/* istanbul ignore next */
					if (isWin && sig === "SIGHUP") sig = "SIGINT";
					/* istanbul ignore next */
					process.kill(process.pid, sig);
				}
			};
		});
		module.exports.signals = function() {
			return signals;
		};
		var loaded = false;
		var load = function load() {
			if (loaded || !processOk(global.process)) return;
			loaded = true;
			emitter.count += 1;
			signals = signals.filter(function(sig) {
				try {
					process.on(sig, sigListeners[sig]);
					return true;
				} catch (er) {
					return false;
				}
			});
			process.emit = processEmit;
			process.reallyExit = processReallyExit;
		};
		module.exports.load = load;
		var originalProcessReallyExit = process.reallyExit;
		var processReallyExit = function processReallyExit(code) {
			/* istanbul ignore if */
			if (!processOk(global.process)) return;
			process.exitCode = code || /* istanbul ignore next */ 0;
			emit("exit", process.exitCode, null);
			/* istanbul ignore next */
			emit("afterexit", process.exitCode, null);
			/* istanbul ignore next */
			originalProcessReallyExit.call(process, process.exitCode);
		};
		var originalProcessEmit = process.emit;
		var processEmit = function processEmit(ev, arg) {
			if (ev === "exit" && processOk(global.process)) {
				/* istanbul ignore else */
				if (arg !== void 0) process.exitCode = arg;
				var ret = originalProcessEmit.apply(this, arguments);
				/* istanbul ignore next */
				emit("exit", process.exitCode, null);
				/* istanbul ignore next */
				emit("afterexit", process.exitCode, null);
				/* istanbul ignore next */
				return ret;
			} else return originalProcessEmit.apply(this, arguments);
		};
	}
}));
//#endregion
//#region node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const cacheSymbol = Symbol();
	function probe(file, fs, callback) {
		const cachedPrecision = fs[cacheSymbol];
		if (cachedPrecision) return fs.stat(file, (err, stat) => {
			/* istanbul ignore if */
			if (err) return callback(err);
			callback(null, stat.mtime, cachedPrecision);
		});
		const mtime = /* @__PURE__ */ new Date(Math.ceil(Date.now() / 1e3) * 1e3 + 5);
		fs.utimes(file, mtime, mtime, (err) => {
			/* istanbul ignore if */
			if (err) return callback(err);
			fs.stat(file, (err, stat) => {
				/* istanbul ignore if */
				if (err) return callback(err);
				const precision = stat.mtime.getTime() % 1e3 === 0 ? "s" : "ms";
				Object.defineProperty(fs, cacheSymbol, { value: precision });
				callback(null, stat.mtime, precision);
			});
		});
	}
	function getMtime(precision) {
		let now = Date.now();
		if (precision === "s") now = Math.ceil(now / 1e3) * 1e3;
		return new Date(now);
	}
	module.exports.probe = probe;
	module.exports.getMtime = getMtime;
}));
//#endregion
//#region node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const path = __require("path");
	const fs = require_graceful_fs();
	const retry = require_retry();
	const onExit = require_signal_exit();
	const mtimePrecision = require_mtime_precision();
	const locks = {};
	function getLockFile(file, options) {
		return options.lockfilePath || `${file}.lock`;
	}
	function resolveCanonicalPath(file, options, callback) {
		if (!options.realpath) return callback(null, path.resolve(file));
		options.fs.realpath(file, callback);
	}
	function acquireLock(file, options, callback) {
		const lockfilePath = getLockFile(file, options);
		options.fs.mkdir(lockfilePath, (err) => {
			if (!err) return mtimePrecision.probe(lockfilePath, options.fs, (err, mtime, mtimePrecision) => {
				/* istanbul ignore if */
				if (err) {
					options.fs.rmdir(lockfilePath, () => {});
					return callback(err);
				}
				callback(null, mtime, mtimePrecision);
			});
			if (err.code !== "EEXIST") return callback(err);
			if (options.stale <= 0) return callback(Object.assign(/* @__PURE__ */ new Error("Lock file is already being held"), {
				code: "ELOCKED",
				file
			}));
			options.fs.stat(lockfilePath, (err, stat) => {
				if (err) {
					if (err.code === "ENOENT") return acquireLock(file, {
						...options,
						stale: 0
					}, callback);
					return callback(err);
				}
				if (!isLockStale(stat, options)) return callback(Object.assign(/* @__PURE__ */ new Error("Lock file is already being held"), {
					code: "ELOCKED",
					file
				}));
				removeLock(file, options, (err) => {
					if (err) return callback(err);
					acquireLock(file, {
						...options,
						stale: 0
					}, callback);
				});
			});
		});
	}
	function isLockStale(stat, options) {
		return stat.mtime.getTime() < Date.now() - options.stale;
	}
	function removeLock(file, options, callback) {
		options.fs.rmdir(getLockFile(file, options), (err) => {
			if (err && err.code !== "ENOENT") return callback(err);
			callback();
		});
	}
	function updateLock(file, options) {
		const lock = locks[file];
		/* istanbul ignore if */
		if (lock.updateTimeout) return;
		lock.updateDelay = lock.updateDelay || options.update;
		lock.updateTimeout = setTimeout(() => {
			lock.updateTimeout = null;
			options.fs.stat(lock.lockfilePath, (err, stat) => {
				const isOverThreshold = lock.lastUpdate + options.stale < Date.now();
				if (err) {
					if (err.code === "ENOENT" || isOverThreshold) return setLockAsCompromised(file, lock, Object.assign(err, { code: "ECOMPROMISED" }));
					lock.updateDelay = 1e3;
					return updateLock(file, options);
				}
				if (!(lock.mtime.getTime() === stat.mtime.getTime())) return setLockAsCompromised(file, lock, Object.assign(/* @__PURE__ */ new Error("Unable to update lock within the stale threshold"), { code: "ECOMPROMISED" }));
				const mtime = mtimePrecision.getMtime(lock.mtimePrecision);
				options.fs.utimes(lock.lockfilePath, mtime, mtime, (err) => {
					const isOverThreshold = lock.lastUpdate + options.stale < Date.now();
					if (lock.released) return;
					if (err) {
						if (err.code === "ENOENT" || isOverThreshold) return setLockAsCompromised(file, lock, Object.assign(err, { code: "ECOMPROMISED" }));
						lock.updateDelay = 1e3;
						return updateLock(file, options);
					}
					lock.mtime = mtime;
					lock.lastUpdate = Date.now();
					lock.updateDelay = null;
					updateLock(file, options);
				});
			});
		}, lock.updateDelay);
		/* istanbul ignore else */
		if (lock.updateTimeout.unref) lock.updateTimeout.unref();
	}
	function setLockAsCompromised(file, lock, err) {
		lock.released = true;
		/* istanbul ignore if */
		if (lock.updateTimeout) clearTimeout(lock.updateTimeout);
		if (locks[file] === lock) delete locks[file];
		lock.options.onCompromised(err);
	}
	function lock(file, options, callback) {
		/* istanbul ignore next */
		options = {
			stale: 1e4,
			update: null,
			realpath: true,
			retries: 0,
			fs,
			onCompromised: (err) => {
				throw err;
			},
			...options
		};
		options.retries = options.retries || 0;
		options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
		options.stale = Math.max(options.stale || 0, 2e3);
		options.update = options.update == null ? options.stale / 2 : options.update || 0;
		options.update = Math.max(Math.min(options.update, options.stale / 2), 1e3);
		resolveCanonicalPath(file, options, (err, file) => {
			if (err) return callback(err);
			const operation = retry.operation(options.retries);
			operation.attempt(() => {
				acquireLock(file, options, (err, mtime, mtimePrecision) => {
					if (operation.retry(err)) return;
					if (err) return callback(operation.mainError());
					const lock = locks[file] = {
						lockfilePath: getLockFile(file, options),
						mtime,
						mtimePrecision,
						options,
						lastUpdate: Date.now()
					};
					updateLock(file, options);
					callback(null, (releasedCallback) => {
						if (lock.released) return releasedCallback && releasedCallback(Object.assign(/* @__PURE__ */ new Error("Lock is already released"), { code: "ERELEASED" }));
						unlock(file, {
							...options,
							realpath: false
						}, releasedCallback);
					});
				});
			});
		});
	}
	function unlock(file, options, callback) {
		options = {
			fs,
			realpath: true,
			...options
		};
		resolveCanonicalPath(file, options, (err, file) => {
			if (err) return callback(err);
			const lock = locks[file];
			if (!lock) return callback(Object.assign(/* @__PURE__ */ new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
			lock.updateTimeout && clearTimeout(lock.updateTimeout);
			lock.released = true;
			delete locks[file];
			removeLock(file, options, callback);
		});
	}
	function check(file, options, callback) {
		options = {
			stale: 1e4,
			realpath: true,
			fs,
			...options
		};
		options.stale = Math.max(options.stale || 0, 2e3);
		resolveCanonicalPath(file, options, (err, file) => {
			if (err) return callback(err);
			options.fs.stat(getLockFile(file, options), (err, stat) => {
				if (err) return err.code === "ENOENT" ? callback(null, false) : callback(err);
				return callback(null, !isLockStale(stat, options));
			});
		});
	}
	function getLocks() {
		return locks;
	}
	/* istanbul ignore next */
	onExit(() => {
		for (const file in locks) {
			const options = locks[file].options;
			try {
				options.fs.rmdirSync(getLockFile(file, options));
			} catch (e) {}
		}
	});
	module.exports.lock = lock;
	module.exports.unlock = unlock;
	module.exports.check = check;
	module.exports.getLocks = getLocks;
}));
//#endregion
//#region node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/adapter.js
var require_adapter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const fs = require_graceful_fs();
	function createSyncFs(fs) {
		const methods = [
			"mkdir",
			"realpath",
			"stat",
			"rmdir",
			"utimes"
		];
		const newFs = { ...fs };
		methods.forEach((method) => {
			newFs[method] = (...args) => {
				const callback = args.pop();
				let ret;
				try {
					ret = fs[`${method}Sync`](...args);
				} catch (err) {
					return callback(err);
				}
				callback(null, ret);
			};
		});
		return newFs;
	}
	function toPromise(method) {
		return (...args) => new Promise((resolve, reject) => {
			args.push((err, result) => {
				if (err) reject(err);
				else resolve(result);
			});
			method(...args);
		});
	}
	function toSync(method) {
		return (...args) => {
			let err;
			let result;
			args.push((_err, _result) => {
				err = _err;
				result = _result;
			});
			method(...args);
			if (err) throw err;
			return result;
		};
	}
	function toSyncOptions(options) {
		options = { ...options };
		options.fs = createSyncFs(options.fs || fs);
		if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) throw Object.assign(/* @__PURE__ */ new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
		return options;
	}
	module.exports = {
		toPromise,
		toSync,
		toSyncOptions
	};
}));
//#endregion
var lockSync = (/* @__PURE__ */ __commonJSMin(((exports, module) => {
	const lockfile = require_lockfile();
	const { toPromise, toSync, toSyncOptions } = require_adapter();
	async function lock(file, options) {
		const release = await toPromise(lockfile.lock)(file, options);
		return toPromise(release);
	}
	function lockSync(file, options) {
		const release = toSync(lockfile.lock)(file, toSyncOptions(options));
		return toSync(release);
	}
	function unlock(file, options) {
		return toPromise(lockfile.unlock)(file, options);
	}
	function unlockSync(file, options) {
		return toSync(lockfile.unlock)(file, toSyncOptions(options));
	}
	function check(file, options) {
		return toPromise(lockfile.check)(file, options);
	}
	function checkSync(file, options) {
		return toSync(lockfile.check)(file, toSyncOptions(options));
	}
	module.exports = lock;
	module.exports.lock = lock;
	module.exports.unlock = unlock;
	module.exports.lockSync = lockSync;
	module.exports.unlockSync = unlockSync;
	module.exports.check = check;
	module.exports.checkSync = checkSync;
})))().lockSync;
export { AgentDelivery, Effects, Engine, HealthBoard, Later, Store, key, killJobs, latestAssignment, lockSync, messageId, runningAssignment, runningJobs, ticketStage };
