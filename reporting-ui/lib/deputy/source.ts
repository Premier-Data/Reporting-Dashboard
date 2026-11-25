// Where a Deputy view gets its rows from. The default is the existing
// deputy-read function (the user's own company); the GameFace page injects its
// own source.
import {
  getDeputyRosters,
  getDeputyRostersWithMeta,
  getDeputyTimesheets,
  type DeputyReadOptions,
  type DeputyReadResult,
  type DeputyRosterRow,
  type DeputyTimesheetRow,
} from "@/lib/api/deputy";

export interface DeputySource {
  getRosters(opts?: DeputyReadOptions): Promise<DeputyRosterRow[]>;
  /** Like getRosters, but also reports whether a sync actually ran. */
  getRostersWithMeta(opts?: DeputyReadOptions): Promise<DeputyReadResult<DeputyRosterRow>>;
  getTimesheets(opts?: DeputyReadOptions): Promise<DeputyTimesheetRow[]>;
}

export const defaultDeputySource: DeputySource = {
  getRosters: (opts) => getDeputyRosters(opts),
  getRostersWithMeta: (opts) => getDeputyRostersWithMeta(opts),
  getTimesheets: (opts) => getDeputyTimesheets(opts),
};
