Component({
  options: {
    styleIsolation: "isolated",
  },

  properties: {
    model: {
      type: Object,
      value: {},
    },
  },

  methods: {
    emit(action, source) {
      if (!action || action.disabled) return;
      this.triggerEvent("action", {
        id: action.id,
        label: action.label,
        payload: action.payload || {},
        source,
      });
    },

    onFocusAction() {
      this.emit(this.data.model.focus && this.data.model.focus.action, "focus");
    },

    onFocusOpen() {
      const focus = this.data.model.focus;
      if (!focus || focus.activation !== "surface") return;
      this.emit(focus.action, "focus");
    },

    onPhaseAction() {
      this.emit(this.data.model.phase && this.data.model.phase.action, "phase");
    },

    onFactAction(event) {
      const fact = (this.data.model.overview || [])[Number(event.currentTarget.dataset.index)];
      this.emit(fact && fact.action, "overview");
    },

    onFilterAction(event) {
      const section = (this.data.model.sections || [])[Number(event.currentTarget.dataset.sectionIndex)];
      const filter = section && section.filters[Number(event.currentTarget.dataset.filterIndex)];
      this.emit(filter && filter.action, "filter");
    },

    onItemAction(event) {
      const section = (this.data.model.sections || [])[Number(event.currentTarget.dataset.sectionIndex)];
      const item = section && section.items[Number(event.currentTarget.dataset.itemIndex)];
      this.emit(item && item.action, "item");
    },

    onMoreAction(event) {
      const section = (this.data.model.sections || [])[Number(event.currentTarget.dataset.sectionIndex)];
      this.emit(section && section.more, "section");
    },

    onDetailAction() {
      this.emit(this.data.model.detailAction, "detail");
    },
  },
});
