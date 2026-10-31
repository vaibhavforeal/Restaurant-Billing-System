import { ComboPickError, isFixedGroup, resolveComboPicks, type ComboChoice, type ComboGroup } from "@forkflow/domain/combos";
import "./combo-choices.css";

/** Why these picks cannot be added yet, in words for staff or a guest; null when they can. */
export function comboPickProblem(groups: ComboGroup[], picks: string[]): string | null {
  try { resolveComboPicks(groups, picks); return null; }
  catch (error) { if (error instanceof ComboPickError) return error.message; throw error; }
}

/** The items the picks put in one combo, with the extra they cost; null while a slot still needs a choice. */
export function comboChoice(groups: ComboGroup[], picks: string[]): { items: ComboChoice[]; extraPaise: number } | null {
  return comboPickProblem(groups, picks) === null ? resolveComboPicks(groups, picks) : null;
}

const slotHint = (group: ComboGroup) => isFixedGroup(group) ? "Always included"
  : group.minPicks === group.maxPicks ? `Choose ${group.minPicks}`
  : group.minPicks === 0 ? `Optional · up to ${group.maxPicks}` : `Choose ${group.minPicks} to ${group.maxPicks}`;

/**
 * A combo's slots as a form: fixed items are listed, a one-pick slot is a set of radio buttons and a larger slot a set of
 * checkboxes that stop at its maximum. Sold-out options cannot be picked.
 */
export function ComboChoices({ groups, picks, onChange, money, disabled = false }: {
  groups: ComboGroup[]; picks: string[]; onChange: (picks: string[]) => void; money: (paise: number) => string; disabled?: boolean;
}) {
  function toggle(group: ComboGroup, optionId: string, checked: boolean) {
    const inGroup = new Set(group.options.map((option) => option.id));
    if (group.maxPicks === 1) onChange([...picks.filter((id) => !inGroup.has(id)), ...(checked ? [optionId] : [])]);
    else onChange(checked ? [...picks, optionId] : picks.filter((id) => id !== optionId));
  }
  return <div className="combo-choices">
    {groups.map((group) => {
      const fixed = isFixedGroup(group);
      const chosen = group.options.filter((option) => picks.includes(option.id)).length;
      return <fieldset key={group.id} className="combo-slot" disabled={disabled}>
        <legend><span>{group.name}</span><small>{slotHint(group)}</small></legend>
        {fixed ? <ul className="combo-fixed">{group.options.map((option) => <li key={option.id}>{option.qty > 1 ? `${option.qty} × ` : ""}{option.name}{option.unavailable && <small className="combo-sold-out"> · Sold out</small>}</li>)}</ul>
          : group.options.map((option) => {
            const checked = picks.includes(option.id);
            const full = group.maxPicks > 1 && !checked && chosen >= group.maxPicks;
            return <label key={option.id} className={`combo-option${checked ? " selected" : ""}`}>
              <input type={group.maxPicks === 1 ? "radio" : "checkbox"} name={`combo-${group.id}`} checked={checked}
                disabled={option.unavailable || full} onChange={(event) => toggle(group, option.id, event.target.checked)} />
              <span>{option.qty > 1 ? `${option.qty} × ` : ""}{option.name}</span>
              <small>{option.unavailable ? "Sold out" : option.extraPricePaise ? `+${money(option.extraPricePaise)}` : ""}</small>
            </label>;
          })}
      </fieldset>;
    })}
  </div>;
}
