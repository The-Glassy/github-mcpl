/**
 * Capability grant state (SPEC 0.5 §5.3, §5.4, §6.4, §6.7).
 *
 * The grant is the security boundary. This class holds what the *host* told
 * this connection it may do, and nothing else. The message-to-grant step, the
 * wildcard matching, and the §6.4 derivation all come from @animalabs/mcpl-core
 * (`grantFromUpdate`, `capabilityGranted`, `deriveFeatureSets`); this wrapper
 * adds the connection-lifetime state around them and the degradation receipt.
 *
 * - `effectiveCapabilities` is the sole normative allowlist. Every path not
 *   present is denied; absence is the denial, there is no unspecified state
 *   (§5.4).
 * - `deniedCapabilities` is derived diagnostic data. It is read only to detect
 *   a malformed policy message and never participates in an authorization
 *   decision (§5.4).
 * - Until the initial policy exchange completes, every capability-dependent
 *   behavior is unavailable (§5.3). `has()` therefore returns false before the
 *   first grant-bearing `featureSets/update` Request.
 *
 * Nothing here widens anything. The degradation receipt this produces is
 * testimony about consequences, never an assertion of entitlement (§6.7).
 *
 * Ported from slack-mcpl's src/grant.ts (itself from zulip-mcp), which is
 * protocol-generic. The github adaptation is the `uses` validation of this
 * server's own declarations and {@link CapabilityGrant.toolAllowed}, which
 * gates a `tools/call` on the github feature set that owns the tool.
 */

import {
  capabilityGranted,
  deriveFeatureSets,
  emptyGrantState,
  featureSetSelected,
  grantFromUpdate,
  isCapabilityPath,
  validateUses,
  type CapabilityGrantState,
  type FeatureSetDeclaration,
  type FeatureSetsUpdateParams,
  type UnavailableFeature,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import { featureSetForTool } from './types.js';

/** SPEC §6.7 — the response to `featureSets/update` is a degradation receipt. */
export interface DegradationReceipt {
  accepted: true;
  /** Omitted when nothing degraded (§6.7). */
  mode?: 'degraded';
  unavailableFeatures: UnavailableFeature[];
  notes: string[];
}

export class CapabilityGrant {
  private state: CapabilityGrantState = emptyGrantState();

  constructor(private declarations: Record<string, FeatureSetDeclaration> = {}) {}

  /**
   * Point the grant at the feature-set declarations of a newly installed
   * manifest (§17.5). Declarations are what degradation is derived from
   * (§6.4); they are not authority, so this widens nothing — the effective
   * grant is untouched and stays whatever the host last sent.
   */
  setDeclarations(declarations: Record<string, FeatureSetDeclaration>): void {
    this.declarations = declarations;
  }

  /**
   * Forget the grant: a new connection starts from nothing (§5.3) — the
   * previous peer's policy is not this peer's.
   */
  reset(): void {
    this.state = emptyGrantState();
  }

  /** True once a grant-bearing `featureSets/update` Request has been accepted. */
  isReady(): boolean {
    return this.state.ready;
  }

  /**
   * Is `path` in the effective grant? False before the initial policy
   * exchange, and false for any path the host did not name.
   */
  has(path: string): boolean {
    if (!this.state.ready) return false;
    return capabilityGranted(this.state.effectiveCapabilities, path);
  }

  /** Is a declared feature set currently active? */
  isFeatureSetActive(name: string): boolean {
    if (!this.state.ready) return false;
    if (!featureSetSelected(this.state, name)) return false;
    return this.missingFor(name).length === 0;
  }

  /**
   * Did the host *select* this feature set — i.e. not disable it (§6.7) —
   * whatever its declared `uses` derive to?
   *
   * Selection and activity differ for a set whose surfaces are gated per
   * capability rather than per set: `github.events` declares `uses:
   * ['pushEvents']`, so it is inactive under a channels-only grant, and yet a
   * `channels/incoming` delivery is still granted. The pipeline asks this
   * first, so a host that turned github.events off gets neither path, and
   * asks `isFeatureSetActive` for the push it declared.
   */
  isFeatureSetSelected(name: string): boolean {
    if (!this.state.ready) return false;
    return featureSetSelected(this.state, name);
  }

  /** Capability paths a declared feature set needs but has not been granted. */
  missingFor(name: string): string[] {
    const decl = this.declarations[name];
    if (!decl) return [];
    return decl.uses.filter((use) => !this.has(use));
  }

  /**
   * May a `tools/call` for `toolName` run? `tools` has to be granted, and the
   * github feature set that owns the tool has to be active. A tool no feature
   * set claims is not reachable: absence is the denial (§5.4).
   */
  toolAllowed(toolName: string): boolean {
    if (!this.has('tools')) return false;
    const featureSet = featureSetForTool(toolName);
    if (!featureSet) return false;
    return this.isFeatureSetActive(featureSet);
  }

  /**
   * Feature sets of this server whose own `uses` is invalid under the closed
   * §6.2 vocabulary — absent, empty, or naming a path that is not a capability
   * path. A host disables such a set with reason `invalid_uses` (§6.4), so this
   * is a declaration bug on our side, not a policy outcome; the startup path
   * and the degradation receipt both surface it rather than letting the feature
   * set go quietly missing.
   */
  invalidDeclarations(): Array<{ featureSet: string; unrecognized: string[] }> {
    return Object.entries(this.declarations)
      .map(([featureSet, decl]) => ({ featureSet, check: validateUses(decl?.uses) }))
      .filter(({ check }) => !check.valid)
      .map(({ featureSet, check }) => ({ featureSet, unrecognized: check.unrecognized }));
  }

  /**
   * Apply a `featureSets/update` and return the degradation receipt (§6.7).
   *
   * Throws {@link McplRpcError} when the message is malformed — §5.4 requires
   * the receiving side to fail closed and reject a policy naming a path in
   * both `effectiveCapabilities` and `deniedCapabilities`. Fail-closed means
   * exactly that: the grant that results holds nothing and is not ready, so a
   * malformed message cannot leave a previous, wider grant standing.
   *
   * `form` is how the message arrived. §6.7 requires the **Request** form for
   * any change to the effective grant and says a Notification "cannot
   * establish a ready state". A Notification therefore never alters the grant
   * except to apply `disabled` reductions — reductions are respected whatever
   * the carrier — and any other grant-bearing field it carries is discarded
   * with a note, because honouring a widening from an unacknowledgeable
   * message would have this server acting on a path the host cannot know it
   * accepted.
   */
  apply(
    params: FeatureSetsUpdateParams,
    form: 'request' | 'notification' = 'request',
  ): DegradationReceipt {
    const result = grantFromUpdate(this.state, params, form);
    const notes: string[] = [];

    if (result.malformed) {
      this.state = result.state;
      throw new McplRpcError(
        -32602,
        'Malformed policy: capability appears in both effectiveCapabilities and deniedCapabilities',
        { capabilities: result.conflicts },
      );
    }

    if (form === 'request' && params.effectiveCapabilities === undefined) {
      // §5.4: effectiveCapabilities is the sole allowlist. Absent means the
      // empty allowlist, not "unchanged" and not "everything".
      notes.push(
        'No effectiveCapabilities in featureSets/update; treating the grant as empty (SPEC 0.5 §5.4).',
      );
    }

    if (form === 'notification') {
      if (result.discarded.length > 0) {
        notes.push(
          `featureSets/update arrived as a Notification; ignored ${result.discarded.join(', ')} — ` +
            'a Notification cannot establish or alter the grant (SPEC 0.5 §6.7). Only `disabled` was applied.',
        );
      }
      if (!result.state.ready) {
        notes.push(
          'featureSets/update arrived as a Notification before the initial policy exchange; a Notification cannot establish a ready state (SPEC 0.5 §6.7), so no capability is in force.',
        );
      }
    }

    const unrecognized = (params.effectiveCapabilities ?? []).filter(
      (p) => typeof p === 'string' && !p.includes('*') && !isCapabilityPath(p),
    );
    if (form === 'request' && unrecognized.length > 0) {
      notes.push(`Ignoring capability paths outside the §6.2 vocabulary: ${unrecognized.join(', ')}`);
    }

    this.state = result.state;

    const derivation = deriveFeatureSets(this.declarations, this.state.effectiveCapabilities);
    const unavailableFeatures: UnavailableFeature[] = Object.entries(derivation.disabled).map(
      ([featureSet, why]) => ({
        featureSet,
        missingCapabilities: why.missingCapabilities as UnavailableFeature['missingCapabilities'],
        effect: 'disabled',
      }),
    );
    for (const [featureSet, why] of Object.entries(derivation.disabled)) {
      // Not the host's policy: our own declaration is unusable (§6.4).
      if (why.reason === 'invalid_uses') {
        notes.push(
          `Feature set ${featureSet} declares an invalid \`uses\` and is disabled (SPEC 0.5 §6.4)` +
            (why.missingCapabilities.length > 0
              ? `; outside the §6.2 vocabulary: ${why.missingCapabilities.join(', ')}`
              : ''),
        );
      }
    }

    return {
      accepted: true,
      ...(unavailableFeatures.length > 0 ? { mode: 'degraded' as const } : {}),
      unavailableFeatures,
      notes,
    };
  }
}
