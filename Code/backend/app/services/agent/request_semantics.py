"""Small shared distinctions between page questions and explicit view commands."""
from __future__ import annotations

import re
from contextvars import ContextVar

# Request-local policy survives local rules, model calls and fallback paths.
request_policy = ContextVar("agent_request_policy", default=None)


def expand_target_declaration(message: str) -> str:
    """A clarified noun phrase supplies a target, not an executable first step."""
    match = re.match(r'^(?:我指的是|我说的是|指的是|指的就是)([^，,；;。]+)[，,；;。]\s*(.+)$', message, re.S)
    if match:
        return re.sub(r'这个图层|该图层|这一层|这层|它', lambda _: match[1], match[2])
    return message


def request_mode(message: str) -> str:
    text = str(message or "")
    if re.search(r'(?:只|仅)(?:介绍|解释|说明)(?:能力|功能|操作范围|支持)', text) and not re.search(r'计划|方案', text):
        return "read_only"
    if re.search(r"(?:只|仅)(?:先)?(?:生成|给出|列出|制定|提供)?(?:操作)?(?:计划|方案)|(?:不要|不|暂不|先不)(?:实际)?执行(?:任何)?(?:操作|动作)?", text):
        return "plan_only"
    if re.search(r"(?:不|不要|禁止)(?:改变|修改|改动)任何(?:状态|图层)|(?:只|仅)(?:做|进行)?(?:查询|统计|读取|解释|介绍|查看)|只读", text):
        return "read_only"
    return "execute"


def explicit_bbox(message: str):
    """Absent is different from explicit-but-invalid; never sort reversed bounds."""
    text = str(message or "")
    number = r"[-+]?\d+(?:\.\d+)?"
    keys = {"west": "西", "east": "东", "south": "南", "north": "北"}
    values = {}
    mentioned = False
    for key, cn in keys.items():
        token = rf"(?:\b{key}\b|{cn}(?:边界|界|边)?)\s*[=:：=]"
        mentioned |= bool(re.search(token, text, re.I))
        match = re.search(token + rf"\s*({number})", text, re.I)
        if match:
            values[key] = float(match.group(1))
    for label, first, last in (("经度", "west", "east"), ("纬度", "south", "north")):
        m = re.search(rf"{label}\s*({number})\s*(?:至|到|~|～)\s*({number})", text)
        if m:
            mentioned = True
            values[first], values[last] = map(float,m.groups())
    if not mentioned:
        return None, None
    if len(values) != 4:
        return None, "矩形范围不完整，需要西、南、东、北四个经纬度；未执行统计。"
    w,s,e,n = (values[k] for k in ("west","south","east","north"))
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        return None, "矩形范围无效：西经度必须小于东经度，南纬度必须小于北纬度，并在合法经纬度范围内；未执行统计，也没有改算整幅栅格。"
    return [w,s,e,n], None

CURRENT_LAYER = re.compile(r"当前(?:选中(?:查看)?的?)?图层|当前选中.{0,5}层|选中的(?:这个|那[个一])?图层|这(?:一|个)?层|该图层|该层|本层")
VISIBILITY_VERB = re.compile(
    r"取消(?:勾选|显示)|不再显示|隐藏|关掉|关闭(?:显示)?|收起|hide|"
    r"勾选|显示|打开|开启|show|只留", re.I
)
HIDE_VERB = re.compile(r"取消(?:勾选|显示)|不再显示|隐藏|关掉|关闭(?:显示)?|收起|hide", re.I)

# Constraints describe permitted changes; they are not extra executable steps.
_KEEP = re.compile(r"(?=.*(?:其他|其余|别的))(?=.*(?:不变|原状|原样|现状|不动|不要改|别动|别改|不改变))")
_REPORT = re.compile(r"^(?:最后|并|再|然后|请|也|分别|逐项)*\s*(?:报告|汇报|反馈|告诉我|说明).*(?:结果|是否成功|完成情况|执行情况|两步|每步)")
_NEGATIVE = re.compile(r"^(?:请|先|再|然后|并|也)*\s*(?:不要|别|不许|不用|无需|不必)\s*(?:再|重新)?(?:隐藏|关闭|关掉|取消勾选|显示|打开|添加|勾选|切换|修改|改变|改动|操作|动|选)")


def separate_constraints(message: str) -> tuple[str, list[str]]:
    """Remove only standalone constraints/output clauses, retaining explicit actions.

    A negative clause can supply the named target for a following pronoun. It
    never changes selection or visibility and is retained for the final guard.
    """
    text = re.sub(r'(?:并且|并|但|同时)(?=保持(?:其他|其余|别的))', '，', message)
    if _NEGATIVE.search(text):
        text = re.sub(r'(?<![，,；;。])(?=(?:只|仅)(?:把|将|改|切换))', '，', text, count=1)
    parts = re.split(r"[，,；;。]+", text)
    actions, constraints = [], []
    anchors = []
    for part in parts:
        text = part.strip()
        if not text:
            continue
        if _KEEP.search(text) or re.search(r"保持(?:原来|原有|原先|原本|原状|不变|现状)|(?:显示状态|日期|样式)保持", text) or _REPORT.search(text):
            constraints.append(text)
        elif _NEGATIVE.search(text):
            constraints.append(text)
            target = _NEGATIVE.sub('', text).strip(' 的了')
            if target and not re.search(r"地图|状态|其他|其余|任何|图层$", target):
                anchors.append(target)
            elif target and re.search(r"SMAP|风云|VOD|SM|CMFD|GPCP", target, re.I):
                anchors.append(target)
        else:
            actions.append(text)
    # Do not turn a pure prohibition/read-only question into an empty request.
    if not actions:
        return message, constraints
    if len(set(anchors)) == 1:
        actions[0] = re.sub(r"这个图层|该图层|这一层|这层|它", anchors[0], actions[0])
    return '，'.join(actions), constraints


def layer_query_topic(message: str) -> str | None:
    match = re.search(r"(?:有哪些|有什么|列出|哪些)(?:当前|目前|现在|已经|已添加|已加载|可用|开放|的|所有|全部|正在|显示|勾选|隐藏)*\s*(.+?)(?:图层|数据)(?:[？?。]|$|，|,)", message)
    if not match:
        return None
    topic = match.group(1).strip(' 的')
    return topic if topic and topic not in {'数据', '活动', '当前', '已添加', '已加载', '可用', '已隐藏', '未勾选', '不可见'} else None


def page_date_query(message: str) -> bool:
    """A current-layer date question, not an instruction or data calculation."""
    text = str(message or "")
    # Negative write constraints do not turn a state question into a date change.
    text = re.sub(r"(?:不要|禁止|无需|不)(?:修改|改变|更改|改动|切换)", "", text)
    if re.search(r"切到|切至|切换|改为|改成|设为|设置|调到|往前|往后|前移|后移|统计|均值|取值|日期范围|可用日期|多少天", text):
        return False
    if re.search(r"(?:^|[，,；;。])\s*(?:请|先|再|然后|把|将)*(?:显示|隐藏|打开|关闭|勾选|取消|添加|加载|加入|选中|选择|切换|切到|换到|查看(?!(?:当前|现在|目前)))", text):
        return False
    current = bool(CURRENT_LAYER.search(text) or re.search(r"选中|当前日期|现在的日期|它的日期", text))
    temporal = bool(re.search(r"日期|时间|哪(?:一)?天|几月|几号|几日", text))
    question = bool(re.search(r"查[询看]|告诉|列出|哪|几月|几号|几日|多少|什么|当前日期|现在的日期", text))
    return current and temporal and question


def page_query_kind(message: str) -> str | None:
    text = str(message or "")
    if re.search(r"(?:^|[，,；;。])\s*(?:请|帮我|先|再|然后|把|将)*\s*(?:添加|加载|加入|选中|选择|切换|切到|换到|查看(?!(?:当前|现在|目前|选中|勾选|已添加|页面|哪些|什么|日期)))", text):
        return None
    if page_date_query(text):
        # Preserve all requested fields in one snapshot response, regardless of
        # commas/question marks; never split a pure state query into actions.
        multiple = bool(re.search(
            r"勾选.*(?:列表|哪些|所有)|(?:列表|哪些|所有).*勾选|哪些.*显示|显示.*(?:哪些|列表)|"
            r"选中.*(?:哪个|什么)|当前图层[、，,]|图层.*(?:数量|总数)", text
        ))
        return "overview" if multiple else "date"
    if layer_query_topic(text) and not page_scoped_layer_query(text):
        return None
    if re.search(r"区分|区别", text) and '选中' in text and '显示' in text:
        return 'overview'
    if '选中' in text and re.search(r"列出.*已添加|各自|每[个一].*显示", text):
        return 'overview'
    # Counts refer to UI rows, not raster statistics; product names may contain 平均.
    if re.search(r"(?:多少|几个|几层|数量|总数)", text) and re.search(r"图层|已添加|已加载", text):
        if not re.search(r"均值|平均值|像元|数值|温度|降水量", text):
            return "count"
    if re.search(r"哪些变量|有什么变量|包含.*变量|有哪些.*变量", text):
        return "variables"
    question = bool(re.search(
        r"是否|是不是|有没有|有无|吗[？?。！!]*$|还是|哪[些个几一层]|什么|列出|告诉我|"
        r"(?:查看|查询).*(?:状态|情况)|"
        r"(?:显示|可见|勾选|打开|开启|隐藏|关闭|开|关)(?:着|了)?没(?:有)?[？?。！!]*$", text
    ))
    if not question:
        return None
    # An explicit imperative can mention selection as its object.
    if re.search(r"(?:^|[，,；;])\s*(?:请|帮我|先|再|然后|把|将)*\s*(?:隐藏|显示|取消|勾选|打开|关掉|关闭|收起|添加|加载|加入|选中|选择|切换|切到|换到)", text):
        return None
    if "选中" in text and re.search(r"所有|哪些|全部", text) and re.search(r"勾选|显示", text) and "？" not in text and "?" not in text:
        return "overview"
    if re.search(r"选中|分析面板.*对应", text):
        return "selected"
    if re.search(r"(?:正在|当前|现在|目前)?.{0,2}(?:查看|操作|关注).{0,6}(?:哪个|哪一|什么).{0,3}(?:图层|层)", text):
        return "selected"
    # General "what layer is current" questions need both selection and
    # visibility, since a selected layer may be hidden. Answer from live state.
    current_question = bool(re.search(r"当前|现在|目前|正在", text))
    layer_question = bool(re.search(r"图层|(?:哪|这)(?:一|个)?层", text))
    identity_question = bool(re.search(r"什么|哪(?:一)?(?:个|层)", text))
    if current_question and layer_question and identity_question:
        if re.search(r"地图上|图上|画面|显示|可见|勾选", text):
            return "visible_list"
        if not re.search(r"切换|切到|添加|移除|删除|统计|均值|日期|时间|时候|小时|坐标|单位|分辨率|来源|包含|变量", text):
            return "overview"
    if re.search(r"显示|可见|勾选|隐藏|开着|关着|已打开|已关闭", text):
        if re.search(r"哪[些几]|列出", text):
            return "hidden_list" if re.search(r"隐藏|未显示|未勾选|不显示|不可见|已关闭", text) else "visible_list"
        return "visible"
    if re.search(r"图层|活动层", text) and re.search(r"哪些|列出|有什么|有哪些", text):
        return "loaded"
    return None


def page_scoped_layer_query(message: str) -> bool:
    # "有哪些降水图层，说明是否已添加" asks the catalog plus page membership.
    # Only the query clause itself decides whether to restrict to page rows.
    clause = re.split(r'[，,？?。；;]', message, maxsplit=1)[0]
    return bool(re.search(r'当前|现在|目前|已添加|已加载|勾选|显示|隐藏|页面', clause))


def exclusive_visibility_target(message: str) -> str | None:
    """Normalize a keep-only imperative even without an explicit others clause."""
    if request_mode(message) != "execute":
        return None
    text = re.split(r"[，,；;。]", message, maxsplit=1)[0].strip()
    if re.search(r"[？?]|是否|是不是|吗[！!]*$", text):
        return None
    match = re.match(r"^(?:请|帮我|麻烦|你)*(?:只显示|仅显示|只保留|仅保留|单独显示|只留|只打开)\s*(.+)$", text)
    if not match:
        return None
    _, constraints = separate_constraints(message)
    if any(_KEEP.search(clause) for clause in constraints):
        return None
    target = re.sub(r"(?:勾选)?显示[！!]*$", "", match[1]).strip(" 的！!")
    return "显示" + target if target else None


def visibility_direction(message: str) -> bool | None:
    if re.search(r"最小值|最大值|图例|值域|量程|不透明度|配色", message):
        return None
    if page_query_kind(message) or not VISIBILITY_VERB.search(message):
        return None
    return not bool(HIDE_VERB.search(message))


def unresolved_target_qualification(message: str) -> bool:
    """A user-declared missing version is a constraint, not a second target."""
    missing = r"(?:还|尚)?(?:未|没(?:有)?)(?:明确|具体)?(?:指定|说明|确定|选择|选|说清)|(?:不清楚|不知道|不确定)"
    version = r"(?:版本|平均(?:版)?(?:(?:和|或|还是|与|、)动态(?:版)?)?|动态(?:版)?(?:(?:和|或|还是|与|、)平均(?:版)?)?)"
    before = r"(?:(?:用|所用|要用)(?:的|哪(?:个|一))?|产品的?|这个产品的?|SMAP|风云|是|的|我|还|尚|\s)*"
    after = r"(?:我|还|尚|都|也|的|是|\s)*"
    for clause in re.split(r"[，,；;。]+", str(message or "")):
        if re.search(r"其他|其余|别的", clause):
            continue
        if re.search(rf"(?:{missing}){before}{version}|{version}{after}(?:{missing})", clause):
            return True
        if re.search(r"(?:先)?(?:别|不要|不能)(?:随便|自行|直接)?猜(?:测)?(?:版本|平均|动态)", clause):
            return True
    return False


def implicit_timeline_target(message: str) -> bool:
    """Recognise an omitted target without treating an unknown layer name as current."""
    text, _ = separate_constraints(str(message or ""))
    if CURRENT_LAYER.search(text):
        return True
    return bool(re.match(
        r"^(?:请|帮我|麻烦|先|再|然后|把|将|只|仅|的|\s)*"
        r"(?:日期|时间|(?:修改|更改|调整|改)(?:日期|时间)|"
        r"(?:切(?:换)?(?:到|至)?|换到|设(?:置)?(?:为|成)?|改(?:到|为|成)|调到|跳到)"
        r"\s*(?=\d|[今昨明前后上下]|次日|翌日)|"
        r"往[前后]|向[前后]|[前后](?:移|推|挪)|前进|后退|提前|推迟|延后)",
        text,
    ))


def relative_day_offset(message: str) -> int | None:
    """Calendar-day offsets relative to the target's remembered date, not today."""
    text = str(message or "")
    single = re.search(r"(?:下|后)(?:一|1)(?:天|日)|次日|翌日|(?:上|前)(?:一|1)(?:天|日)", text)
    if single:
        return -1 if single[0].startswith(("上", "前")) else 1
    match = re.search(
        r"(?:(?:往|向)?(?P<direction>[前后])(?:移动|移|推|挪)?|"
        r"(?P<verb>前进|后退|提前|推迟|延后))"
        r"(?P<count>[一二两三四五六七八九十\d]+)(?:个)?(?:天|日)", text
    )
    if not match:
        return None
    count_text = match["count"].replace("两", "二")
    if count_text.isdigit():
        count = int(count_text)
    elif count_text == "十":
        count = 10
    elif "十" in count_text:
        tens, _, ones = count_text.partition("十")
        digits = "一二三四五六七八九"
        if len(tens) > 1 or len(ones) > 1 or any(c not in digits for c in tens + ones):
            return None
        count = (digits.index(tens) + 1 if tens else 1) * 10
        count += digits.index(ones) + 1 if ones else 0
    else:
        if len(count_text) != 1 or count_text not in "一二三四五六七八九":
            return None
        count = "一二三四五六七八九".index(count_text) + 1
    sign = -1 if match["direction"] == "前" or match["verb"] in {"后退", "提前"} else 1
    return sign * count


def has_timeline_request(message: str) -> bool:
    """A time change needs a real date/hour expression, not a digit in FY3."""
    text, _ = separate_constraints(str(message or ""))
    if page_date_query(text):
        return False
    action = re.search(r"切(?:换)?(?:到|至)?|换到|日期|时间|设为|设置|调到|改(?:到|为|成)|跳到|(?:往|向)[前后]|[前后](?:移|推|挪)|前进|后退|提前|推迟|延后", text)
    value = re.search(
        r"\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|(?<!\d)\d{8}(?!\d)|"
        r"\d{1,2}月\d{1,2}[日号]?|\d{1,2}[-/]\d{1,2}|"
        r"\d{1,2}(?:点|时|号|日)|\d{1,2}:\d{2}|"
        r"当天|当日|今天|昨天|明天|前一天|后一天|[前后](?:移|推|挪).{0,5}天", text)
    return bool(action and (value or relative_day_offset(text) is not None))


def layer_action_kind(message: str) -> str | None:
    """Classify layer list, selection and visibility independently of targeting."""
    text, _ = separate_constraints(str(message or ""))
    if page_query_kind(text) or has_timeline_request(text):
        return None
    if re.match(r"^(?:请|帮我)?(?:查询|列出|告诉我|有哪些|有什么|是否|有没有|介绍|说明)", text.strip()):
        return None
    if re.search(r"图例|值域|量程|不透明度|透明度|配色|统计|均值|平均值|取值|取数|工作流|底图|定位|缩放|播放|暂停", text):
        return None
    if re.match(r"^(?:请|先|再|然后|并|也)*(?:不要|别|不许|不用|无需|不必)", text.strip()):
        return None
    if HIDE_VERB.search(text):
        return "hide_layer"
    if re.search(r"勾选|显示|打开|开启|show|只留", text, re.I):
        return "show_layer"
    if re.search(r"添加|加入|加载|add_layer", text, re.I):
        return "add_layer"
    if re.search(r"选中|选择|切换(?:到|至|为)?|切(?:到|至)|换到|查看|设为当前|作为当前|select_layer", text, re.I):
        return "select_layer"
    return None
