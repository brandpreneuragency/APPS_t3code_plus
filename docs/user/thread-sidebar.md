# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

To require confirmation before unpinning, enable **Settings → General → Unpin confirmation**. The
confirmation applies to the sidebar controls, thread menus, and the `mod+shift+p` shortcut.

## Projects

On web and desktop, the default sidebar keeps a project list on the left. Choose a project to
show only its threads, or choose **All projects** to show every thread again. Search narrows that
list. The settings control on a project opens its settings, and **+** adds a project. A custom
workspace keeps its own project folders and does not use this list.

The thread column ends with a **New thread** button that creates directly in the selected
project. Unlike the icon at the top right, it never opens the project picker.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

In the card sidebar on web and desktop, drag the grip at the top left of an active or pinned card,
before its folder icon, to arrange that list. Release to keep its position, or press Escape to cancel.
You can also focus the grip, press Space or Enter, use the arrow keys to move, and press Space or Enter
again to drop. Other buttons and links on the card keep their usual actions. Pinned, snoozed, and
settled threads stay in their own sections.

Active card order is saved on this desktop installation or browser address and survives reloads.
It does not sync to other devices or change the native mobile app. Project filters preserve the
positions of hidden cards. New and un-settled threads appear at the top; other activity does not
change your manual order.

If pinned thread reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Workspaces

Workspace thread dots are orange while the agent is working and green when it finishes,
even after you read the result. Settled threads use a muted grey dot. Idle and disconnected
threads also use grey; approval and input prompts keep their distinct indicators.

On desktop and Alpha development web, workspaces organize projects into named sidebar views. Use **+** above the footer to
create one, then select its dot to switch to it. Hover a dot to see its name; use its context menu
to rename or delete it. Drag custom workspace dots to arrange them. **Default** always stays first
and keeps your usual sidebar, including the legacy layout if you use it.

Use **Home** before the previous-workspace arrow to return directly to Default while keeping
your current chat open. Home is disabled when Default is already selected.

Use the home button before the arrows to return directly to **Default**. It is disabled while
Default is selected. Use the previous and next arrows beside the dots, or hold and drag an empty area of the sidebar
left for the next workspace and right for the previous one. Release after dragging at least 60 pixels
horizontally to switch. Navigation stops at the first and last workspace. Dragging buttons,
project folders, or chat rows keeps their usual behavior.

A workspace can contain projects from several connected environments, including local folders and
remote servers. Add existing projects or browse for a new folder in its environment. Each project
can belong to one custom workspace and remains available in Default. If it already belongs to
another workspace, choose **Move** to transfer it. Empty workspaces and empty project folders are
allowed.

When an environment is disconnected, its project folder remains in the workspace with its saved
label and path. Actions that require the server are disabled until it reconnects; adding a new
folder is always sent to the environment chosen in the picker.

Switching workspaces changes the sidebar while keeping your open chat, running agent, composer,
and tools in place. An open chat outside the selected workspace stays open without adding a row
to that workspace. New-chat commands use projects in the selected workspace; the terminal and
file tools continue to use the open chat's project.

Custom workspaces show compact chats inside collapsible project folders. Drag folders to arrange
projects, and drag chats within the same project and status group to arrange them. Active chats
appear above settled chats. New chats appear at the front of their group; subsequent activity
does not reorder existing chats. Pinning still applies in Default, but does not override manual
order in a custom workspace.

Each folder initially shows up to three settled chats with quieter text. **Load More** reveals
three more, and **Show Less** restores the initial limit. Snoozed chats have a separate compact
disclosure with their usual wake actions. Archived chats stay out of ordinary sidebar rows.

Search in a custom workspace matches chat titles within its attached projects, including chats
hidden by collapsed folders or Load More. The command palette uses the same title-search scope;
Default keeps its usual search behavior. Opening a hidden result reveals its position in the
folder. Search inside the open chat and file search keep their existing scope.

An unavailable environment leaves its project folders in place. They become usable again when
the connection returns. Removing a project from a workspace or deleting a workspace only removes
that organization: it does not delete projects, chats, or files. You can attach a removed project
again. If a workspace is deleted while an add-folder picker is open, the project is created in
Default and the open chat is left where it is.

Workspace names, membership, order, folder expansion, and your last selected workspace are saved
on this desktop installation or browser address. Browser and desktop layouts are separate and
do not sync to other clients. Search text and Load More state
are remembered while switching workspaces in one session and reset when the app restarts.
Standalone web and mobile keep their existing sidebar.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
