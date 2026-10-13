import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PromptLibrary, SavedPrompt } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpenIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { randomUUID } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  filterPrompts,
  movePrompt,
  orderedPrompts,
  parsePromptTags,
  promptTagStyles,
} from "./promptLibrary";

interface ComposerSnapshot {
  value: string;
  expandedCursor: number;
}

interface PromptLibraryMenuProps {
  readSnapshot: () => ComposerSnapshot;
  onInsert: (text: string, snapshot: ComposerSnapshot) => boolean;
}

function IconAction({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Pick<React.ComponentProps<typeof Button>, "onClick" | "disabled" | "aria-pressed">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function PromptLibraryMenu(props: PromptLibraryMenuProps) {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? (
    <ConnectedPromptLibrary key={environmentId} environmentId={environmentId} {...props} />
  ) : null;
}

function ConnectedPromptLibrary({
  environmentId,
  readSnapshot,
  onInsert,
}: PromptLibraryMenuProps & { environmentId: EnvironmentId }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const library = settings?.promptLibrary ?? {};
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "save prompt library");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<(SavedPrompt & { id: string; isNew: boolean }) | null>(
    null,
  );
  const [tagsInput, setTagsInput] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const snapshotRef = useRef<ComposerSnapshot>({ value: "", expandedCursor: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const insertedRef = useRef(false);
  const savingRef = useRef(false);
  const allPrompts = orderedPrompts(library);
  const tags = [...new Set(allPrompts.flatMap((prompt) => prompt.tags))].sort();
  const tagStyles = promptTagStyles(tags);
  const selectedTag = tag && tags.includes(tag) ? tag : null;
  const visible = filterPrompts(library, query, selectedTag, favoritesOnly);
  const disabled = busy || !settings;

  async function persist(patch: PromptLibrary) {
    if (savingRef.current || !settings) return false;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { promptLibrary: patch } },
      });
      if (result._tag !== "Success") {
        setError("Could not save the prompt library. Your changes are still open; try again.");
        return false;
      }
      const accepted = Object.entries(patch).every(([id, expected]) => {
        const actual = result.value.promptLibrary?.[id];
        return expected === null
          ? !actual
          : actual &&
              actual.title === expected.title &&
              actual.text === expected.text &&
              actual.favorite === expected.favorite &&
              actual.order === expected.order &&
              JSON.stringify(actual.tags) === JSON.stringify(expected.tags);
      });
      if (!accepted) {
        setError(
          "This server did not save the library. Connect to the updated dev server and try again.",
        );
        return false;
      }
      return true;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }

  function editPrompt(prompt?: SavedPrompt & { id: string }, text = "") {
    setOpen(false);
    setError(null);
    setConfirmDelete(false);
    setTagsInput(prompt?.tags.join(", ") ?? "");
    setEditing(
      prompt
        ? { ...prompt, isNew: false }
        : {
            id: randomUUID(),
            isNew: true,
            title: "",
            text,
            tags: [],
            favorite: false,
            order: Math.max(-1, ...allPrompts.map((entry) => entry.order)) + 1,
          },
    );
  }

  async function savePrompt() {
    if (!editing) return;
    const parsedTags = parsePromptTags(tagsInput, tags);
    if (parsedTags.length > 20 || parsedTags.some((name) => name.length > 40)) {
      setError("Use up to 20 tags, with at most 40 characters per tag.");
      return;
    }
    if (!editing.isNew && !library[editing.id]) {
      setError("This prompt was deleted on another device. Create a new prompt to keep this text.");
      return;
    }
    const { id, isNew: _isNew, ...prompt } = editing;
    const latest = library[id];
    if (
      await persist({
        [id]: {
          ...prompt,
          title: prompt.title.trim(),
          tags: parsedTags,
          order: latest?.order ?? prompt.order,
          favorite: latest?.favorite ?? prompt.favorite,
        },
      })
    ) {
      setEditing(null);
      setOpen(true);
    }
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            snapshotRef.current = readSnapshot();
            insertedRef.current = false;
            setError(null);
          }
          setOpen(nextOpen);
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    ref={triggerRef}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Prompt library"
                    onPointerDown={(event) => event.preventDefault()}
                  />
                }
              />
            }
          >
            <BookOpenIcon />
          </TooltipTrigger>
          <TooltipPopup>Prompt library</TooltipPopup>
        </Tooltip>
        <PopoverPopup
          side="top"
          align="end"
          className="w-[min(26rem,calc(100vw-2rem))]"
          finalFocus={() => (insertedRef.current ? false : triggerRef.current)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.stopPropagation();
          }}
        >
          <div className="flex max-h-(--available-height) min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
              <PopoverTitle className="text-sm">Prompt library</PopoverTitle>
              <div className="flex gap-1">
                <IconAction
                  label="Save current draft"
                  disabled={disabled || !snapshotRef.current.value.trim()}
                  onClick={() => editPrompt(undefined, snapshotRef.current.value)}
                >
                  <SaveIcon />
                </IconAction>
                <IconAction label="New prompt" disabled={disabled} onClick={() => editPrompt()}>
                  <PlusIcon />
                </IconAction>
              </div>
            </div>
            <div
              className="flex shrink-0 gap-2 overflow-x-auto px-3 pb-2"
              role="group"
              aria-label="Filter prompts by tag"
            >
              <Button
                variant={selectedTag === null ? "secondary" : "ghost"}
                size="xs"
                aria-pressed={selectedTag === null}
                onClick={() => setTag(null)}
              >
                All
              </Button>
              {tags.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={selectedTag === name}
                  className="shrink-0 rounded-md px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-1 aria-pressed:ring-offset-popover"
                  style={tagStyles.get(name)}
                  onClick={() => setTag(selectedTag === name ? null : name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 px-3 pb-2">
              <Input
                type="search"
                size="sm"
                aria-label="Search prompts"
                placeholder="Search prompts"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <IconAction
                label="Favorites only"
                aria-pressed={favoritesOnly}
                onClick={() => setFavoritesOnly(!favoritesOnly)}
              >
                <StarIcon className={favoritesOnly ? "fill-amber-400 text-amber-400" : undefined} />
              </IconAction>
            </div>
            {error && (
              <p role="alert" className="px-3 pb-2 text-xs text-destructive-foreground">
                {error}
              </p>
            )}
            <div className="min-h-0 max-h-72 overflow-y-auto px-2 pb-2" aria-label="Saved prompts">
              {!settings ? (
                <p className="p-3 text-sm text-muted-foreground">Loading prompts...</p>
              ) : visible.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  {allPrompts.length ? "No matching prompts." : "No saved prompts yet."}
                </p>
              ) : (
                visible.map((prompt, index) => (
                  <div
                    key={prompt.id}
                    className="flex items-center gap-1 rounded-md hover:bg-accent focus-within:bg-accent"
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-md px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Insert ${prompt.title}`}
                      onClick={() => {
                        if (onInsert(prompt.text, snapshotRef.current)) {
                          insertedRef.current = true;
                          setOpen(false);
                        } else
                          setError(
                            "The draft changed while the library was open. Close and reopen the library to insert here.",
                          );
                      }}
                    >
                      <span className="block truncate text-sm font-medium">{prompt.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {prompt.text}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center">
                      <IconAction
                        label={`${prompt.favorite ? "Unfavorite" : "Favorite"} ${prompt.title}`}
                        disabled={disabled}
                        aria-pressed={prompt.favorite}
                        onClick={() => {
                          const { id, ...entry } = prompt;
                          void persist({ [id]: { ...entry, favorite: !entry.favorite } });
                        }}
                      >
                        <StarIcon
                          className={prompt.favorite ? "fill-amber-400 text-amber-400" : undefined}
                        />
                      </IconAction>
                      <IconAction
                        label={`Move ${prompt.title} up`}
                        disabled={disabled || index === 0}
                        onClick={() =>
                          void persist(
                            movePrompt(
                              library,
                              visible.map((entry) => entry.id),
                              prompt.id,
                              -1,
                            ),
                          )
                        }
                      >
                        <ArrowUpIcon />
                      </IconAction>
                      <IconAction
                        label={`Move ${prompt.title} down`}
                        disabled={disabled || index === visible.length - 1}
                        onClick={() =>
                          void persist(
                            movePrompt(
                              library,
                              visible.map((entry) => entry.id),
                              prompt.id,
                              1,
                            ),
                          )
                        }
                      >
                        <ArrowDownIcon />
                      </IconAction>
                      <IconAction
                        label={`Edit ${prompt.title}`}
                        disabled={disabled}
                        onClick={() => editPrompt(prompt)}
                      >
                        <PencilIcon />
                      </IconAction>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <Dialog
        open={editing !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !busy) setEditing(null);
        }}
      >
        <DialogPopup finalFocus={triggerRef}>
          {editing && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void savePrompt();
              }}
            >
              <DialogHeader>
                <DialogTitle>{editing.isNew ? "New prompt" : "Edit prompt"}</DialogTitle>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <label className="block space-y-1 text-sm">
                  Title
                  <Input
                    autoFocus
                    required
                    maxLength={200}
                    value={editing.title}
                    disabled={busy}
                    onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  Prompt
                  <Textarea
                    required
                    maxLength={100_000}
                    rows={8}
                    className="max-h-64 overflow-y-auto"
                    value={editing.text}
                    disabled={busy}
                    onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  />
                </label>
                <label className="block space-y-1 text-sm">
                  Tags (comma separated)
                  <Input
                    value={tagsInput}
                    disabled={busy}
                    onChange={(event) => setTagsInput(event.target.value)}
                  />
                </label>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Existing tags">
                    {tags.map((name) => {
                      const assigned = parsePromptTags(tagsInput, tags);
                      const selected = assigned.includes(name);
                      return (
                        <button
                          key={name}
                          type="button"
                          disabled={busy}
                          aria-pressed={selected}
                          className="max-w-full truncate rounded-md px-2 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                          style={tagStyles.get(name)}
                          onClick={() =>
                            setTagsInput(
                              (selected
                                ? assigned.filter((entry) => entry !== name)
                                : [...assigned, name]
                              ).join(", "),
                            )
                          }
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive-foreground">
                    {error}
                  </p>
                )}
                {confirmDelete && (
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>Delete this prompt?</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        if (await persist({ [editing.id]: null })) {
                          setEditing(null);
                          setOpen(true);
                        }
                      }}
                    >
                      Delete
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      Keep
                    </Button>
                  </div>
                )}
              </DialogPanel>
              <DialogFooter>
                {!editing.isNew && (
                  <div className="mr-auto">
                    <IconAction
                      label="Delete prompt"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2Icon />
                    </IconAction>
                  </div>
                )}
                <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={disabled || !editing.title.trim() || !editing.text.trim()}
                >
                  {busy ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
