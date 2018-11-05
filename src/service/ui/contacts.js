'use strict';

const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const Color = imports.service.components.color;


/**
 * Get Gdk.Pixbuf for @path, allowing the corrupt JPEG's KDE Connect sometimes
 * sends. This function is synchronous
 *
 * @param {string} path - A local file path
 */
function getPixbuf(path, size = null) {
    let data, loader;

    // Catch missing avatar files
    try {
        data = GLib.file_get_contents(path)[1];
    } catch (e) {
        logWarning(e.message, path);
        return undefined;
    }

    // Consider errors from partially corrupt JPEGs to be warnings
    try {
        loader = new GdkPixbuf.PixbufLoader();
        loader.write(data);
        loader.close();
    } catch (e) {
        logWarning(e, path);
    }

    let pixbuf = loader.get_pixbuf();

    // Scale if requested
    if (size !== null) {
        return pixbuf.scale_simple(size, size, GdkPixbuf.InterpType.HYPER);
    } else {
        return pixbuf;
    }
}


/**
 * Return a localized string for a phone number type
 * See: http://www.ietf.org/rfc/rfc2426.txt
 *
 * @param {string} type - An RFC2426 phone number type
 */
function localizeNumberType(type) {
    if (!type) return _('Other');

    switch (true) {
        case type.includes('fax'):
            // TRANSLATORS: A phone number type
            return _('Fax');

        case type.includes('work'):
            // TRANSLATORS: A phone number type
            return _('Work');

        case type.includes('cell'):
            // TRANSLATORS: A phone number type
            return _('Mobile');

        case type.includes('home'):
            // TRANSLATORS: A phone number type
            return _('Home');

        default:
            // TRANSLATORS: A phone number type
            return _('Other');
    }
}


/**
 * Contact Avatar
 */
var Avatar = GObject.registerClass({
    GTypeName: 'GSConnectContactAvatar'
}, class Avatar extends Gtk.DrawingArea {

    _init(contact) {
        super._init({
            height_request: 32,
            width_request: 32,
            visible: true,
            tooltip_text: contact.name || _('Unknown Contact')
        });

        this._path = contact.avatar;
    }

    _loadPixbuf() {
        if (this._path) {
            this._pixbuf = getPixbuf(this._path, 32);
        }

        if (this._pixbuf === undefined) {
            this._fallback = true;

            this.bg_color = Color.randomRGBA(this.tooltip_text);

            let info = Gtk.IconTheme.get_default().lookup_icon(
                'avatar-default',
                24,
                Gtk.IconLookupFlags.FORCE_SYMBOLIC
            );

            this._pixbuf = info.load_symbolic(
                Color.getFgRGBA(this.bg_color),
                null,
                null,
                null
            )[0];
        }

        this._offset = (this.width_request - this._pixbuf.width) / 2;
    }

    vfunc_draw(cr) {
        if (this._pixbuf === undefined) {
            this._loadPixbuf();
        }

        // Clip to a circle
        cr.arc(16, 16, 16, 0, 2 * Math.PI);
        cr.clipPreserve();

        // Fill the background if we don't have an avatar
        if (this._fallback) {
            Gdk.cairo_set_source_rgba(cr, this.bg_color);
            cr.fill();
        }

        // Draw the avatar/icon
        Gdk.cairo_set_source_pixbuf(cr, this._pixbuf, this._offset, this._offset);
        cr.paint();

        cr.$dispose();
        return Gdk.EVENT_PROPAGATE;
    }
});


var ContactChooser = GObject.registerClass({
    GTypeName: 'GSConnectContactChooser',
    Properties: {
        'store': GObject.ParamSpec.object(
            'store',
            'Store',
            'The contacts store',
            GObject.ParamFlags.READWRITE,
            GObject.Object
        ),
        'selected': GObject.param_spec_variant(
            'selected',
            'selectedContacts',
            'A list of selected contacts',
            new GLib.VariantType('as'),
            null,
            GObject.ParamFlags.READABLE
        )
    },
    Signals: {
        'number-selected': {
            flags: GObject.SignalFlags.RUN_FIRST,
            param_types: [GObject.TYPE_STRING]
        }
    }
}, class ContactChooser extends Gtk.ScrolledWindow {

    _init(params) {
        super._init(Object.assign({
            can_focus: false,
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            visible: true
        }, params));
        this.get_style_context().add_class('contact-list');

        this._contactsNotifyId = this.store.connect(
            'notify::contacts',
            this._populate.bind(this)
        );

        this._temporary = undefined;

        // Search Entry
        this.entry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: _('Type a phone number or name'),
            tooltip_text: _('Type a phone number or name'),
            primary_icon_name: 'x-office-address-book-symbolic.symbolic',
            primary_icon_activatable: false,
            primary_icon_sensitive: true,
            input_purpose: Gtk.InputPurpose.PHONE,
            visible: true
        });
        this.entry.get_style_context().add_class('contact-entry');
        this.entry.connect('changed', this._onEntryChanged.bind(this));

        // ListBox
        this.list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            visible: true
        });
        this.list.connect('row-activated', this._onNumberSelected.bind(this));
        this.list._entry = this.entry.text;
        this.list.set_filter_func(this._filter);
        this.list.set_sort_func(this._sort);
        this.add(this.list);

        // Placeholder
        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            margin: 12,
            spacing: 12,
            visible: true
        });
        this.list.set_placeholder(box);

        let placeholderImage = new Gtk.Image({
            icon_name: 'avatar-default-symbolic',
            pixel_size: 48,
            visible: true
        });
        placeholderImage.get_style_context().add_class('dim-label');
        box.add(placeholderImage);

        // TODO: label needs to be updated
        let placeholderLabel = new Gtk.Label({
            label: '<b>' + _('Add people to start a conversation') + '</b>',
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER,
            visible: true
        });
        placeholderLabel.get_style_context().add_class('dim-label');
        box.add(placeholderLabel);

        // Populate and setup
        this._populate();
    }

    get selected () {
        let selected = new Set();
        this.list.foreach(row => {
            row.selected.map(number => selected.add(number));
        });
        return Array.from(selected);
    }

    _destroy() {
        // Explicitly disconnect & destroy the entry in case it's floating
        this.entry.disconnect(this._entryChangedId);

        if (this.entry.get_parent() === null) {
            this.entry.destroy();
        }

        this.store.disconnect(this._contactsNotifyId);
    }

    _onEntryChanged(entry) {
        this.list._entry = entry.text;

        // If the entry contains string with 2 or more digits...
        if (entry.text.replace(/\D/g, '').length >= 2) {
            // ...ensure we have a temporary contact for it
            if (this._temporary === undefined) {
                this._temporary = this.add_contact({
                    // TRANSLATORS: A phone number (eg. "Send to 555-5555")
                    name: _('Send to %s').format(this.entry.text),
                    numbers: [{type: 'unknown', value: this.entry.text}]
                });
                this._temporary.__manual = true;

            // ...or if we already do, then update it
            } else {
                // Update UI
                let grid = this._temporary.get_child();
                let nameLabel = grid.get_child_at(1, 0);
                nameLabel.label = _('Send to %s').format(this.entry.text);
                let numLabel = grid.get_child_at(1, 1);
                numLabel.label = this.entry.text + '・' + localizeNumberType('unknown');

                // Update contact object
                this._temporary.contact.name = this.entry.text;
                this._temporary.contact.numbers[0].value = this.entry.text;
            }

        // ...otherwise remove any temporary contact that's been created
        } else if (this._temporary) {
            this._temporary.destroy();
            this._temporary = undefined;
        }

        this.list.invalidate_filter();
        this.list.invalidate_sort();
    }

    _onNumberSelected(list, row) {
        this.entry.text = '';
        this.list.select_row(null);
        this.vadjustment.value = 0;

        let address = row.number.value;
        this.emit('number-selected', address);
    }

    _populate() {
        this.list.foreach(row => row.destroy());

        for (let contact of this.store) {
            this.add_contact(contact);
        }
    }

    _filter(row) {
        let list = row.get_parent();

        // Dynamic contact always shown
        if (row.__manual) return true;

        let queryName = list._entry.toLocaleLowerCase();
        let queryNumber = list._entry.toPhoneNumber();

        // Show contact if text is substring of name
        if (row.contact.name.toLocaleLowerCase().includes(queryName)) {
            return true;

        // Show contact if text is substring of number
        } else if (queryNumber.length) {
            for (let number of row.contact.numbers) {
                if (number.value.toPhoneNumber().includes(queryNumber)) {
                    return true;
                }
            }
        }

        return false;
    }

    _sort(row1, row2) {
        if (row1.__manual) {
            return -1;
        } else if (row2.__manual) {
            return 1;
        }

        return row1.contact.name.localeCompare(row2.contact.name);
    }

    add_contact(contact) {
        if (contact.numbers.length === 1) {
            return this.add_contact_number(contact, 0);
        }

        for (let i = 0; i < contact.numbers.length; i++) {
            this.add_contact_number(contact, i);
        }
    }

    add_contact_number(contact, index) {
        let row = new Gtk.ListBoxRow({
            activatable: true,
            selectable: true
        });
        row.contact = contact;
        row.number = contact.numbers[index];
        this.list.add(row);

        let grid = new Gtk.Grid({
            margin: 6,
            column_spacing: 6
        });
        row.add(grid);

        if (index === 0) {
            let avatar = new Avatar(contact);
            avatar.valign = Gtk.Align.CENTER;
            grid.attach(avatar, 0, 0, 1, 2);

            let nameLabel = new Gtk.Label({
                label: contact.name || _('Unknown Contact'),
                halign: Gtk.Align.START,
                hexpand: true,
                visible: true
            });
            grid.attach(nameLabel, 1, 0, 1, 1);
        }

        let numLabel = new Gtk.Label({
            label: row.number.value + '・' + localizeNumberType(row.number.type),
            halign: Gtk.Align.START,
            hexpand: true,
            margin_start: (index > 0) ? 38 : 0,
            visible: true
        });
        numLabel.get_style_context().add_class('dim-label');
        grid.attach(numLabel, 1, 1, 1, 1);

        row.show_all();
        return row;
    }

    /**
     * Reset the selected contacts and re-populate the list
     */
    reset() {
        this.list.foreach(row => {
            row.numbers.map(number => {
                number.selected = false;
            });
        });
    }
});

