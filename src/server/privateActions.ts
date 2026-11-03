/*
 * Audit actions that leave a row for the record or a rate limit but are never shown in the public feed. They
 * hold who did something small and private, such as answering about an ear-tip or suggesting a name. This file
 * imports nothing, so any module can use it without a cycle.
 */

export const EAR_TIP_ANSWERED = "ear_tip_answered";
export const NAME_SUGGESTED = "name_suggested";
export const NAME_ANOTHER = "name_another";
export const NAME_APPROVED = "name_approved";
export const NAME_DISMISSED = "name_dismissed";
export const NAME_SET = "name_set";

export const PRIVATE_ACTIONS: readonly string[] = [EAR_TIP_ANSWERED, NAME_SUGGESTED, NAME_ANOTHER, NAME_APPROVED, NAME_DISMISSED, NAME_SET];
