// v1.1 -- 2026-08-21 -- Bills are editable in place, and a bill can be part-paid:
// record a payment against it, see the remaining balance, and let it settle itself
// once the balance reaches zero.
import { BadgeDollarSign, CheckCircle2, CircleDollarSign, Pencil, Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import type { Bill } from "../types";
import {
  applyBillPayment,
  billAmountPaid,
  billRemaining,
  currency,
  frequencyForRecurringChoice,
  isPartiallyPaid,
  makeId,
  roundCurrency,
  todayStr,
} from "../utils";

type BillsViewProps = {
  bills: Bill[];
  onSaveBills: (bills: Bill[]) => void;
};

type BillForm = {
  name: string;
  amount: string;
  amountPaid: string;
  dueDate: string;
  category: string;
  recurring: boolean;
};

const EMPTY_FORM: BillForm = {
  name: "",
  amount: "",
  amountPaid: "",
  dueDate: todayStr(),
  category: "",
  recurring: false,
};

export function BillsView({ bills, onSaveBills }: BillsViewProps) {
  const [form, setForm] = useState<BillForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which bill has its payment panel open, and what has been typed into it.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [paymentDraft, setPaymentDraft] = useState("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const activeBills = useMemo(() => bills.filter((bill) => !bill.deleted), [bills]);
  const editingBill = useMemo(
    () => (editingId ? activeBills.find((bill) => bill.id === editingId) || null : null),
    [activeBills, editingId]
  );

  const summary = useMemo(() => {
    // Outstanding counts what is still owed, not the face value of unpaid bills, so a
    // part-paid bill stops overstating the total the moment a payment lands.
    const outstanding = activeBills.reduce((sum, bill) => sum + billRemaining(bill), 0);
    const paid = activeBills.reduce((sum, bill) => sum + billAmountPaid(bill), 0);
    const nextDue = activeBills
      .filter((bill) => !bill.paid)
      .slice()
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.dueDate;

    return { outstanding: roundCurrency(outstanding), paid: roundCurrency(paid), nextDue: nextDue || "Clear" };
  }, [activeBills]);

  function update<K extends keyof BillForm>(key: K, value: BillForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(bill: Bill) {
    setEditingId(bill.id);
    setPayingId(null);
    const paidSoFar = billAmountPaid(bill);
    setForm({
      name: bill.name,
      amount: String(bill.amount ?? ""),
      amountPaid: paidSoFar ? String(paidSoFar) : "",
      dueDate: bill.dueDate || todayStr(),
      category: bill.category || "",
      recurring: Boolean(bill.recurring),
    });
    nameInputRef.current?.focus();
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, dueDate: todayStr() });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = form.name.trim();
    const amount = roundCurrency(Number(form.amount));
    if (!name || !amount || !form.dueDate) return;

    const category = form.category.trim() || undefined;
    // Blank means "nothing paid yet"; anything typed is clamped to the bill amount so the
    // ledger can never show more paid than owed.
    const amountPaid = Math.min(Math.max(0, roundCurrency(Number(form.amountPaid) || 0)), amount);
    const paid = amountPaid >= amount;

    if (editingId) {
      onSaveBills(
        bills.map((bill) =>
          bill.id === editingId
            ? {
                // Spread first so fields the form never shows -- payee, notes, payment
                // account, autopay, status -- survive an edit instead of being wiped.
                ...bill,
                name,
                amount,
                amountPaid,
                paid,
                dueDate: form.dueDate,
                category,
                recurring: form.recurring,
                frequency: frequencyForRecurringChoice(form.recurring, bill.frequency),
                updatedAt: Date.now(),
              }
            : bill
        )
      );
      cancelEdit();
      return;
    }

    onSaveBills([
      ...bills,
      {
        id: makeId("bill"),
        name,
        amount,
        amountPaid,
        dueDate: form.dueDate,
        paid,
        category,
        recurring: form.recurring,
        frequency: frequencyForRecurringChoice(form.recurring),
        updatedAt: Date.now(),
      },
    ]);
    setForm({ ...EMPTY_FORM, dueDate: todayStr() });
  }

  /** Settle a bill outright, or reopen it with nothing paid against it. */
  function toggleBill(id: string) {
    // Close any panel open on this bill first. The edit form holds a snapshot taken when
    // it opened, so leaving it open over a toggle lets a later Save write the pre-toggle
    // amounts back over the change.
    if (editingId === id) cancelEdit();
    if (payingId === id) closePayment();
    onSaveBills(
      bills.map((bill) =>
        bill.id === id
          ? bill.paid
            ? { ...bill, paid: false, amountPaid: 0, updatedAt: Date.now() }
            : { ...bill, paid: true, amountPaid: Math.max(0, roundCurrency(bill.amount)), updatedAt: Date.now() }
          : bill
      )
    );
  }

  function openPayment(bill: Bill) {
    // Never leave the edit form open behind the payment panel: its snapshot of
    // `amountPaid` predates the payment, and saving it would erase the payment.
    cancelEdit();
    setPayingId(bill.id);
    // Prefill the balance: paying in full is the common case, and a partial payment is
    // one edit away.
    setPaymentDraft(String(billRemaining(bill)));
  }

  function closePayment() {
    setPayingId(null);
    setPaymentDraft("");
  }

  function recordPayment(bill: Bill) {
    const payment = roundCurrency(Number(paymentDraft));
    if (!(payment > 0)) return;
    onSaveBills(bills.map((entry) => (entry.id === bill.id ? applyBillPayment(entry, payment) : entry)));
    closePayment();
  }

  /** Wipe the payment history on a bill -- the undo for a mistyped amount. */
  function clearPayments(id: string) {
    onSaveBills(
      bills.map((bill) => (bill.id === id ? { ...bill, paid: false, amountPaid: 0, updatedAt: Date.now() } : bill))
    );
    closePayment();
  }

  function deleteBill(id: string) {
    const bill = bills.find((entry) => entry.id === id);
    if (bill && !window.confirm(`Delete "${bill.name}"?`)) return;
    if (editingId === id) cancelEdit();
    if (payingId === id) closePayment();
    onSaveBills(bills.map((entry) => (entry.id === id ? { ...entry, deleted: true, updatedAt: Date.now() } : entry)));
  }

  return (
    <section className="content-surface">
      <div>
        <p className="eyebrow">Bills &amp; expenses</p>
        <h2 className="page-title">Financial ledger</h2>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <div className="summary-tile">
          <span>Total Outstanding</span>
          <strong>{currency(summary.outstanding)}</strong>
        </div>
        <div className="summary-tile">
          <span>Total Paid</span>
          <strong>{currency(summary.paid)}</strong>
        </div>
        <div className="summary-tile">
          <span>Next Due Date</span>
          <strong>{summary.nextDue}</strong>
        </div>
      </div>

      {editingBill ? (
        <p className="bill-edit-banner" role="status">
          Editing <strong>{editingBill.name}</strong>
        </p>
      ) : null}

      <form
        className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_8rem_8rem_10rem_minmax(0,1fr)_auto_auto]"
        onSubmit={submit}
      >
        <label className="sr-only" htmlFor="bill-name">
          Bill name
        </label>
        <input
          id="bill-name"
          ref={nameInputRef}
          value={form.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Bill name"
        />
        <label className="sr-only" htmlFor="bill-amount">
          Amount
        </label>
        <input
          id="bill-amount"
          type="number"
          min="0"
          step="0.01"
          value={form.amount}
          onChange={(event) => update("amount", event.target.value)}
          placeholder="Amount"
        />
        <label className="sr-only" htmlFor="bill-amount-paid">
          Paid so far
        </label>
        <input
          id="bill-amount-paid"
          type="number"
          min="0"
          step="0.01"
          value={form.amountPaid}
          onChange={(event) => update("amountPaid", event.target.value)}
          placeholder="Paid so far"
        />
        <label className="sr-only" htmlFor="bill-date">
          Due date
        </label>
        <input
          id="bill-date"
          type="date"
          value={form.dueDate}
          onChange={(event) => update("dueDate", event.target.value)}
        />
        <label className="sr-only" htmlFor="bill-category">
          Category
        </label>
        <input
          id="bill-category"
          value={form.category}
          onChange={(event) => update("category", event.target.value)}
          placeholder="Category"
        />
        <label className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-semibold text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300"
            checked={form.recurring}
            onChange={(event) => update("recurring", event.target.checked)}
          />
          Recurring
        </label>
        <div className="flex gap-2">
          <button className="btn-primary" type="submit">
            {editingId ? <Save size={17} /> : <Plus size={17} />}
            {editingId ? "Save" : "Add"}
          </button>
          {editingId ? (
            <button className="btn-secondary" type="button" onClick={cancelEdit}>
              <X size={17} />
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      <div className="mt-5 grid gap-3">
        {activeBills
          .slice()
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((bill) => {
            const paidSoFar = billAmountPaid(bill);
            const remaining = billRemaining(bill);
            const partial = isPartiallyPaid(bill);

            return (
              <article
                key={bill.id}
                className={`bill-row ${bill.paid ? "bill-row-paid" : ""} ${partial ? "bill-row-partial" : ""} ${
                  bill.id === editingId ? "bill-row-editing" : ""
                }`}
              >
                <button
                  className="icon-button"
                  type="button"
                  aria-label={bill.paid ? `Mark ${bill.name} unpaid` : `Mark ${bill.name} paid in full`}
                  onClick={() => toggleBill(bill.id)}
                >
                  {bill.paid ? <CheckCircle2 size={18} /> : <BadgeDollarSign size={18} />}
                </button>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-slate-950">{bill.name}</h3>
                  <p className="text-xs text-slate-500">
                    {bill.dueDate}
                    {bill.category ? ` · ${bill.category}` : ""}
                    {bill.recurring ? " · recurring" : ""}
                  </p>
                </div>
                <div className="bill-amounts">
                  <strong className="text-sm text-slate-950">{currency(partial ? remaining : bill.amount)}</strong>
                  {partial ? (
                    <span className="bill-paid-note">
                      {currency(paidSoFar)} paid of {currency(bill.amount)}
                    </span>
                  ) : null}
                </div>
                <div className="bill-actions">
                  {bill.paid ? null : (
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Record a payment on ${bill.name}`}
                      onClick={() => (payingId === bill.id ? closePayment() : openPayment(bill))}
                      aria-expanded={payingId === bill.id}
                    >
                      <CircleDollarSign size={15} />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Edit ${bill.name}`}
                    onClick={() => startEdit(bill)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={`Delete ${bill.name}`}
                    onClick={() => deleteBill(bill.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>

                {payingId === bill.id && !bill.paid ? (
                  <div className="bill-payment">
                    <label className="bill-payment-label" htmlFor={`bill-payment-${bill.id}`}>
                      Payment amount
                    </label>
                    <input
                      id={`bill-payment-${bill.id}`}
                      type="number"
                      min="0"
                      step="0.01"
                      max={remaining}
                      value={paymentDraft}
                      autoFocus
                      onChange={(event) => setPaymentDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          recordPayment(bill);
                        }
                        if (event.key === "Escape") closePayment();
                      }}
                    />
                    <span className="bill-payment-hint">{currency(remaining)} remaining</span>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-primary" type="button" onClick={() => recordPayment(bill)}>
                        <CircleDollarSign size={16} />
                        Record payment
                      </button>
                      {paidSoFar > 0 ? (
                        <button className="btn-secondary" type="button" onClick={() => clearPayments(bill.id)}>
                          <RotateCcw size={16} />
                          Clear payments
                        </button>
                      ) : null}
                      <button className="btn-secondary" type="button" onClick={closePayment}>
                        <X size={16} />
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
      </div>
    </section>
  );
}
